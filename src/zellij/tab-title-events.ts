import type { SessionStatus as OpenCodeSessionStatus } from '@opencode-ai/sdk'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

const execFileAsync = promisify(execFile)

export interface OpenCodeEventLike {
  type: string
  properties: unknown
}

export interface TabTitleEventManager {
  updateSessionStatus: (sessionID: string, status: OpenCodeSessionStatus) => void
  markSessionIdle: (sessionID: string) => void
  removeSession: (sessionID: string) => void
  markNeedsInput: (id: string, sessionID: string) => void
  clearNeedsInput: (id: string) => void
  setBranch: (branch: string | undefined) => void
  destroy?: () => void | Promise<void>
}

export type BranchReader = (worktree: string) => Promise<string>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringProperty(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

function nestedStringProperty(object: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  const nested = object[key]
  if (!isRecord(nested))
    return undefined
  return stringProperty(nested, nestedKey)
}

function sessionStatusProperty(object: Record<string, unknown>): OpenCodeSessionStatus | undefined {
  const status = object.status
  if (!isRecord(status))
    return undefined

  if (status.type === 'idle' || status.type === 'busy')
    return { type: status.type }

  if (status.type === 'retry') {
    return {
      type: 'retry',
      attempt: typeof status.attempt === 'number' ? status.attempt : 0,
      message: typeof status.message === 'string' ? status.message : '',
      next: typeof status.next === 'number' ? status.next : 0,
    }
  }

  return undefined
}

function inputRequestID(object: Record<string, unknown>): string | undefined {
  return stringProperty(object, 'id') ?? stringProperty(object, 'requestID') ?? stringProperty(object, 'permissionID')
}

function inputState(object: Record<string, unknown>): string | undefined {
  return (stringProperty(object, 'status') ?? stringProperty(object, 'state') ?? stringProperty(object, 'type'))?.toLowerCase()
}

function isResolvedInputState(state: string | undefined): boolean {
  return state === 'approved' || state === 'denied' || state === 'rejected' || state === 'resolved' || state === 'replied'
}

export function deletedSessionID(event: OpenCodeEventLike): string | undefined {
  if (!isRecord(event.properties))
    return undefined
  return nestedStringProperty(event.properties, 'info', 'id') ?? stringProperty(event.properties, 'sessionID')
}

async function readGitBranch(worktree: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', worktree, 'branch', '--show-current'], {
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 1024 * 1024,
  })
  return result.stdout
}

export async function getInitialBranch(worktree: string, readBranch: BranchReader = readGitBranch): Promise<string | undefined> {
  try {
    return (await readBranch(worktree)).trim() || undefined
  }
  catch (error) {
    debug('getInitialBranch failed', errorMessage(error))
    return undefined
  }
}

export function shouldReadInitialBranch(zellij: string | undefined): boolean {
  return Boolean(zellij)
}

export function handleTabTitleEvent(tabTitleManager: TabTitleEventManager, event: OpenCodeEventLike): void | Promise<void> {
  if (event.type === 'server.instance.disposed' || event.type === 'global.disposed')
    return tabTitleManager.destroy?.()

  if (!isRecord(event.properties))
    return

  const properties = event.properties

  switch (event.type) {
    case 'session.status': {
      const sessionID = stringProperty(properties, 'sessionID')
      const status = sessionStatusProperty(properties)
      // Busy/retry events are safe optimistic updates. Idle-like events are
      // intentionally reconciled from `/session/status` by the plugin instead:
      // a lone parent/child idle event can be stale during subagent handoff.
      if (sessionID && status && status.type !== 'idle')
        tabTitleManager.updateSessionStatus(sessionID, status)
      break
    }
    case 'session.idle': {
      // Base idle is snapshot-driven; see the session.status note above.
      break
    }
    case 'session.error': {
      // Base idle is snapshot-driven; see the session.status note above.
      break
    }
    case 'vcs.branch.updated': {
      tabTitleManager.setBranch(stringProperty(properties, 'branch'))
      break
    }
    case 'question.asked':
    case 'permission.asked': {
      const id = inputRequestID(properties)
      const sessionID = stringProperty(properties, 'sessionID')
      if (id && sessionID) {
        tabTitleManager.markNeedsInput(id, sessionID)
        tabTitleManager.updateSessionStatus(sessionID, { type: 'busy' })
      }
      break
    }
    case 'permission.updated': {
      const id = inputRequestID(properties)
      const sessionID = stringProperty(properties, 'sessionID')
      const state = inputState(properties)
      if (id && isResolvedInputState(state)) {
        tabTitleManager.clearNeedsInput(id)
        if (sessionID)
          tabTitleManager.updateSessionStatus(sessionID, { type: 'busy' })
      }
      else if (id && sessionID) {
        tabTitleManager.markNeedsInput(id, sessionID)
        tabTitleManager.updateSessionStatus(sessionID, { type: 'busy' })
      }
      break
    }
    case 'question.replied':
    case 'question.rejected':
    case 'permission.replied': {
      const id = inputRequestID(properties)
      const sessionID = stringProperty(properties, 'sessionID')
      if (id)
        tabTitleManager.clearNeedsInput(id)
      if (sessionID)
        tabTitleManager.updateSessionStatus(sessionID, { type: 'busy' })
      break
    }
    case 'session.deleted': {
      const sessionID = deletedSessionID(event)
      if (sessionID)
        tabTitleManager.removeSession(sessionID)
      break
    }
  }
}
