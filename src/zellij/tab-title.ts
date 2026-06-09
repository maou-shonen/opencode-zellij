import process from 'node:process'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { ZellijCli } from './cli.js'

export interface TabTitleCli {
  renameTab: (title: string) => Promise<void>
  currentTabTitle: () => Promise<string | undefined>
}

export type TabTitleStatus = 'idle' | 'running' | 'needs-input'

export interface TabTitleEmojis {
  idle: string
  running: string
  needsInput: string
  branch: string
}

export const defaultTabTitleEmojis: TabTitleEmojis = {
  idle: '🟢',
  running: '⚡',
  needsInput: '💬',
  branch: '🌱',
}

export interface TitleContext {
  projectName: string
  branchName: string | undefined
  status: TabTitleStatus
  emojis: TabTitleEmojis
}

export function formatTabTitle(context: TitleContext): string {
  const branch = context.branchName ? ` ${context.emojis.branch} ${context.branchName}` : ''
  const emoji = context.emojis[context.status === 'needs-input' ? 'needsInput' : context.status]
  return `${emoji} ${context.projectName}${branch}`
}

export function sanitizeTitle(title: string, maxLength = 90): string {
  let cleaned = title
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const chars = Array.from(cleaned)
  if (chars.length > maxLength) {
    cleaned = `${chars.slice(0, maxLength - 1).join('')}…`
  }

  return cleaned
}

// Helper functions for event parsing (mirrored from tab-title-events.ts)
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

function sessionStatusType(properties: Record<string, unknown>): 'idle' | 'busy' | 'retry' | undefined {
  const status = properties.status
  if (!isRecord(status))
    return undefined
  const type = status.type
  if (type === 'idle' || type === 'busy')
    return type
  if (type === 'retry')
    return 'retry'
  return undefined
}

function inputRequestID(properties: Record<string, unknown>): string | undefined {
  return stringProperty(properties, 'id') ?? stringProperty(properties, 'requestID') ?? stringProperty(properties, 'permissionID')
}

function inputState(properties: Record<string, unknown>): string | undefined {
  return (stringProperty(properties, 'status') ?? stringProperty(properties, 'state') ?? stringProperty(properties, 'type'))?.toLowerCase()
}

function isResolvedInputState(state: string | undefined): boolean {
  return state === 'approved' || state === 'denied' || state === 'rejected' || state === 'resolved' || state === 'replied'
}

function deletedSessionID(properties: Record<string, unknown>): string | undefined {
  return nestedStringProperty(properties, 'info', 'id') ?? stringProperty(properties, 'sessionID')
}

interface SessionRecord {
  directory: string | undefined
  parentID: string | undefined
}

export class TabTitleIdentityModel {
  ready: Promise<void>
  projectName: string
  branchName: string | undefined
  private worktree: string
  private readBranch: (worktree: string) => Promise<string>
  private refreshGeneration = 0

  constructor(options: {
    projectName: string
    worktree: string
    readBranch: (worktree: string) => Promise<string>
  }) {
    this.projectName = options.projectName
    this.worktree = options.worktree
    this.readBranch = options.readBranch
    this.ready = this.refreshBranch('initial')
  }

  async refreshBranch(_reason?: string): Promise<void> {
    const generation = ++this.refreshGeneration
    try {
      const result = await this.readBranch(this.worktree)
      if (generation !== this.refreshGeneration)
        return
      const trimmed = result.trim() || undefined
      this.branchName = trimmed
    }
    catch (error) {
      if (generation !== this.refreshGeneration)
        return
      debug('refreshBranch failed', errorMessage(error))
      // keep previous branch
    }
  }

  handleEvent(event: { type: string, properties?: unknown }): Promise<void> | void {
    if (event.type === 'vcs.branch.updated') {
      return this.refreshBranch('vcs.branch.updated')
    }
  }
}

export class TabTitleActivityModel {
  status: 'idle' | 'running' | 'needs-input' = 'idle'
  private worktreeDirectory: string
  private sessions = new Map<string, SessionRecord>()
  private scopedSessions = new Set<string>()
  private runningSessions = new Set<string>()
  private pendingInputs = new Map<string, string>()

  constructor(options: { worktreeDirectory: string }) {
    this.worktreeDirectory = options.worktreeDirectory
  }

  getSession(sessionID: string): SessionRecord | undefined {
    return this.scopedSessions.has(sessionID) ? this.sessions.get(sessionID) : undefined
  }

  hasPendingInput(sessionID: string, requestID: string): boolean {
    return this.pendingInputs.has(`${sessionID}:${requestID}`)
  }

  handleEvent(event: { type: string, properties?: unknown }): void {
    if (!isRecord(event.properties))
      return

    const properties = event.properties

    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = properties.info
        if (isRecord(info)) {
          const id = stringProperty(info, 'id')
          if (id)
            this.storeSession(id, info)
        }
        break
      }
      case 'session.status': {
        const sessionID = stringProperty(properties, 'sessionID')
        const statusType = sessionStatusType(properties)
        if (sessionID && statusType) {
          if (statusType === 'idle') {
            if (this.runningSessions.has(sessionID)) {
              this.runningSessions.delete(sessionID)
              this.updateStatus()
            }
          }
          else if (statusType === 'busy' || statusType === 'retry') {
            if (this.scopedSessions.has(sessionID)) {
              this.runningSessions.add(sessionID)
              this.updateStatus()
            }
          }
        }
        break
      }
      case 'session.idle':
      case 'session.error': {
        const sessionID = stringProperty(properties, 'sessionID')
        if (sessionID && this.runningSessions.has(sessionID)) {
          this.runningSessions.delete(sessionID)
          this.updateStatus()
        }
        break
      }
      case 'question.asked':
      case 'permission.asked': {
        const id = inputRequestID(properties)
        const sessionID = stringProperty(properties, 'sessionID')
        if (id && sessionID && this.scopedSessions.has(sessionID)) {
          this.pendingInputs.set(`${sessionID}:${id}`, sessionID)
          this.runningSessions.add(sessionID)
          this.updateStatus()
        }
        break
      }
      case 'permission.updated': {
        const id = inputRequestID(properties)
        const sessionID = stringProperty(properties, 'sessionID')
        const state = inputState(properties)
        if (id && isResolvedInputState(state)) {
          this.pendingInputs.delete(`${sessionID}:${id}`)
          if (sessionID && this.runningSessions.has(sessionID))
            this.runningSessions.add(sessionID)
          this.updateStatus()
        }
        else if (id && sessionID && this.scopedSessions.has(sessionID)) {
          this.pendingInputs.set(`${sessionID}:${id}`, sessionID)
          this.runningSessions.add(sessionID)
          this.updateStatus()
        }
        break
      }
      case 'question.replied':
      case 'question.rejected':
      case 'permission.replied': {
        const id = inputRequestID(properties)
        const sessionID = stringProperty(properties, 'sessionID')
        if (id)
          this.pendingInputs.delete(`${sessionID}:${id}`)
        if (sessionID && this.runningSessions.has(sessionID))
          this.runningSessions.add(sessionID)
        this.updateStatus()
        break
      }
      case 'session.deleted': {
        const sessionID = deletedSessionID(properties)
        if (sessionID) {
          this.removeSessionAndDescendants(sessionID)
          this.updateStatus()
        }
        break
      }
    }
  }

  private storeSession(id: string, info: Record<string, unknown>): void {
    const directory = stringProperty(info, 'directory')
    const parentID = stringProperty(info, 'parentID')
    this.sessions.set(id, { directory, parentID })

    const isDirectlyScoped = directory === this.worktreeDirectory
    const isDescendantScoped = parentID ? this.scopedSessions.has(parentID) : false
    const isKnown = this.scopedSessions.has(id)

    if (isKnown || isDirectlyScoped || isDescendantScoped)
      this.scopedSessions.add(id)
  }

  private removeSessionAndDescendants(rootID: string): void {
    const toRemove = new Set<string>()
    toRemove.add(rootID)

    let changed = true
    while (changed) {
      changed = false
      for (const [id, session] of this.sessions) {
        if (!toRemove.has(id) && session.parentID && toRemove.has(session.parentID)) {
          toRemove.add(id)
          changed = true
        }
      }
    }

    for (const id of toRemove) {
      this.sessions.delete(id)
      this.scopedSessions.delete(id)
      this.runningSessions.delete(id)
    }

    for (const [key, sessionID] of [...this.pendingInputs.entries()]) {
      if (toRemove.has(sessionID))
        this.pendingInputs.delete(key)
    }
  }

  private updateStatus(): void {
    if (this.pendingInputs.size > 0)
      this.status = 'needs-input'
    else if (this.runningSessions.size > 0)
      this.status = 'running'
    else
      this.status = 'idle'
  }
}

export class TabTitleActor {
  ready: Promise<void>
  private identity: TabTitleIdentityModel
  private activity: TabTitleActivityModel
  private emojis: TabTitleEmojis

  constructor(options: {
    identity: TabTitleIdentityModel
    activity: TabTitleActivityModel
    emojis?: Partial<TabTitleEmojis> | undefined
  }) {
    this.identity = options.identity
    this.activity = options.activity
    this.emojis = { ...defaultTabTitleEmojis, ...options.emojis }
    this.ready = this.identity.ready
  }

  get context() {
    return {
      projectName: this.identity.projectName,
      branchName: this.identity.branchName,
      status: this.activity.status,
    }
  }

  get title(): string {
    return formatTabTitle({
      ...this.context,
      emojis: this.emojis,
    })
  }

  async handleEvent(event: { type: string, properties?: unknown }): Promise<void> {
    this.activity.handleEvent(event)

    const identityResult = this.identity.handleEvent(event)
    if (identityResult instanceof Promise)
      await identityResult
  }
}

export interface TabTitleManagerOptions {
  cli?: TabTitleCli
  emojis?: Partial<TabTitleEmojis> | undefined
  debounceMs?: number
  retryInitialMs?: number
  retryMaxMs?: number
  actor: TabTitleActor
}

export class TabTitleManager {
  private desiredTitle: string | undefined
  private lastSyncedTitle: string | undefined
  private syncGeneration = 0
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private syncInFlight = false
  private syncPromise: Promise<void> | undefined
  private readonly debounceMs: number
  private readonly retryInitialMs: number
  private readonly retryMaxMs: number
  private readonly cli: TabTitleCli
  private readonly emojis: TabTitleEmojis
  private readonly enabled: boolean
  private destroyed = false
  private destroyPromise: Promise<void> | undefined
  private readonly actor: TabTitleActor

  constructor(options: TabTitleManagerOptions) {
    this.cli = options.cli ?? new ZellijCli()
    this.emojis = { ...defaultTabTitleEmojis, ...options.emojis }
    this.debounceMs = options.debounceMs ?? 300
    this.retryInitialMs = options.retryInitialMs ?? 250
    this.retryMaxMs = options.retryMaxMs ?? 5_000
    this.enabled = Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME)
    this.actor = options.actor
  }

  private buildTitle(): string {
    return sanitizeTitle(formatTabTitle({
      ...this.actor.context,
      emojis: this.emojis,
    }))
  }

  getCurrentTitle(): string {
    return this.buildTitle()
  }

  async renderImmediate(): Promise<void> {
    if (!this.enabled || this.destroyed)
      return
    this.desiredTitle = this.buildTitle()
    this.clearDebounceTimer()
    await this.syncDesiredTitle()
  }

  scheduleUpdate(): void {
    if (!this.enabled || this.destroyed)
      return
    const title = this.buildTitle()
    if (title === this.desiredTitle && title === this.lastSyncedTitle)
      return
    this.desiredTitle = title

    if (this.syncInFlight)
      return

    this.clearRetryTimer()
    this.clearDebounceTimer()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      this.syncDesiredTitle()
        .catch(error => debug('debounced tab title sync failed', errorMessage(error)))
    }, this.debounceMs)
    this.unrefTimer(this.debounceTimer)
  }

  private async syncDesiredTitle(): Promise<void> {
    if (!this.enabled || this.destroyed)
      return
    const generation = this.syncGeneration
    if (this.destroyed || generation !== this.syncGeneration)
      return
    if (this.syncInFlight)
      return this.syncPromise

    this.syncInFlight = true
    this.syncPromise = this.runTitleSync(generation)
    return this.syncPromise
  }

  private async runTitleSync(generation: number): Promise<void> {
    try {
      while (generation === this.syncGeneration && this.desiredTitle && this.desiredTitle !== this.lastSyncedTitle) {
        const title = this.desiredTitle
        try {
          await this.cli.renameTab(title)
          if (generation !== this.syncGeneration || this.destroyed)
            return
          this.lastSyncedTitle = title
          this.retryAttempt = 0
          this.clearRetryTimer()
        }
        catch (cause) {
          debug('Failed to rename Zellij tab.', cause)
          if (generation !== this.syncGeneration || this.destroyed)
            break
          this.scheduleRetry()
          break
        }
      }
    }
    finally {
      this.syncInFlight = false
      this.syncPromise = undefined
    }
  }

  private scheduleRetry(): void {
    if (!this.enabled || this.destroyed || this.retryTimer || this.desiredTitle === this.lastSyncedTitle)
      return

    const delay = Math.min(this.retryMaxMs, this.retryInitialMs * 2 ** this.retryAttempt)
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.syncDesiredTitle()
        .catch(error => debug('retry tab title sync failed', errorMessage(error)))
    }, delay)
    this.unrefTimer(this.retryTimer)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer)
      clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function')
      timer.unref()
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer)
      clearTimeout(this.debounceTimer)
    this.debounceTimer = undefined
  }

  // No-op. Previously this method captured the tab title and restored it
  // on destroy, but in practice the opencode plugin lifecycle never
  // dispatches a reliable "session ended" event in any mode (TUI
  // worker shutdown, `opencode run` headless, or `opencode run --interactive`
  // all exit without firing `server.instance.disposed` / `global.disposed`).
  // `process.once('exit')` only supports sync callbacks so it cannot drive
  // the async Zellij rename, and SIGKILL cannot be intercepted at all.
  // The remaining work is to clear timers so a straggler sync cannot race
  // the process exit; the tab title we set is simply left in place.
  destroy(): Promise<void> {
    if (this.destroyed)
      return this.destroyPromise ?? Promise.resolve()
    this.destroyed = true
    this.syncGeneration += 1
    this.desiredTitle = undefined
    this.clearDebounceTimer()
    this.clearRetryTimer()
    return Promise.resolve()
  }
}
