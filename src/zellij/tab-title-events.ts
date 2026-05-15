import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

const execFileAsync = promisify(execFile)

export interface OpenCodeEventLike {
  type: string
  properties: unknown
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
