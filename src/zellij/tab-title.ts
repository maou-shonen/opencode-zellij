import type { SessionStatus as OpenCodeSessionStatus } from '@opencode-ai/sdk'
import process from 'node:process'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { ZellijCli } from './cli.js'

export interface TabTitleCli {
  renameTab: (title: string) => Promise<void>
  currentTabTitle: () => Promise<string | undefined>
}

export type TabTitleStatus = 'idle' | 'running' | 'needs-input'

type SessionActivity = 'idle' | 'running'

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

export interface TabTitleManagerOptions {
  projectName: string
  branchName?: string | undefined
  cli?: TabTitleCli
  emojis?: Partial<TabTitleEmojis> | undefined
  debounceMs?: number
  retryInitialMs?: number
  retryMaxMs?: number
}

export class TabTitleManager {
  private readonly sessionStatuses = new Map<string, SessionActivity>()
  private readonly pendingInputs = new Map<string, string>()
  private branchName: string | undefined
  private desiredTitle: string | undefined
  private lastSyncedTitle: string | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private syncInFlight = false
  private syncPromise: Promise<void> | undefined
  private readonly debounceMs: number
  private readonly retryInitialMs: number
  private readonly retryMaxMs: number
  private readonly projectName: string
  private readonly cli: TabTitleCli
  private readonly emojis: TabTitleEmojis
  private readonly enabled: boolean
  private destroyed = false
  private originalTabTitle: string | undefined
  private originalTabTitleLoaded = false
  private originalTabTitlePromise: Promise<void> | undefined
  private destroyPromise: Promise<void> | undefined

  constructor(options: TabTitleManagerOptions) {
    this.projectName = options.projectName
    this.branchName = options.branchName?.trim() || undefined
    this.cli = options.cli ?? new ZellijCli()
    this.emojis = { ...defaultTabTitleEmojis, ...options.emojis }
    this.debounceMs = options.debounceMs ?? 300
    this.retryInitialMs = options.retryInitialMs ?? 250
    this.retryMaxMs = options.retryMaxMs ?? 5_000
    this.enabled = Boolean(process.env.ZELLIJ)
  }

  setBranch(branch: string | undefined): void {
    const trimmed = branch?.trim() || undefined
    if (this.branchName === trimmed)
      return
    this.branchName = trimmed
    this.scheduleUpdate()
  }

  updateSessionStatus(sessionID: string, status: OpenCodeSessionStatus): void {
    const activity: SessionActivity = status.type === 'idle' ? 'idle' : 'running'
    const existing = this.sessionStatuses.get(sessionID)
    if (existing === activity)
      return
    this.sessionStatuses.set(sessionID, activity)
    this.scheduleUpdate()
  }

  markSessionIdle(sessionID: string): void {
    this.updateSessionStatus(sessionID, { type: 'idle' })
  }

  removeSession(sessionID: string): void {
    const hadSessionStatus = this.sessionStatuses.delete(sessionID)
    let hadPendingInput = false
    for (const [id, pendingSessionID] of this.pendingInputs) {
      if (pendingSessionID === sessionID) {
        this.pendingInputs.delete(id)
        hadPendingInput = true
      }
    }

    if (!hadSessionStatus && !hadPendingInput)
      return
    this.scheduleUpdate()
  }

  markNeedsInput(id: string, sessionID: string): void {
    if (this.pendingInputs.get(id) === sessionID)
      return
    this.pendingInputs.set(id, sessionID)
    this.scheduleUpdate()
  }

  clearNeedsInput(id: string): void {
    if (!this.pendingInputs.delete(id))
      return
    this.scheduleUpdate()
  }

  private get isBusy(): boolean {
    for (const activity of this.sessionStatuses.values()) {
      if (activity === 'running')
        return true
    }
    return false
  }

  private get needsInput(): boolean {
    return this.pendingInputs.size > 0
  }

  private get status(): TabTitleStatus {
    if (this.needsInput)
      return 'needs-input'
    if (this.isBusy)
      return 'running'
    return 'idle'
  }

  private buildTitle(): string {
    const context: TitleContext = {
      projectName: this.projectName,
      branchName: this.branchName,
      status: this.status,
      emojis: this.emojis,
    }
    return sanitizeTitle(formatTabTitle(context))
  }

  getCurrentTitle(): string {
    return this.buildTitle()
  }

  async renderImmediate(): Promise<void> {
    if (!this.enabled || this.destroyed)
      return
    await this.ensureOriginalTabTitle()
    if (this.destroyed)
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
    await this.ensureOriginalTabTitle()
    if (this.destroyed)
      return
    if (this.syncInFlight)
      return this.syncPromise

    this.syncInFlight = true
    this.syncPromise = this.runTitleSync()
    return this.syncPromise
  }

  private async runTitleSync(): Promise<void> {
    try {
      while (this.desiredTitle && this.desiredTitle !== this.lastSyncedTitle) {
        const title = this.desiredTitle
        try {
          await this.cli.renameTab(title)
          this.lastSyncedTitle = title
          this.retryAttempt = 0
          this.clearRetryTimer()
        }
        catch (cause) {
          debug('Failed to rename Zellij tab.', cause)
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

  private async ensureOriginalTabTitle(): Promise<void> {
    if (!this.enabled || this.originalTabTitleLoaded)
      return
    if (this.originalTabTitlePromise)
      return this.originalTabTitlePromise

    this.originalTabTitlePromise = this.saveOriginalTabTitle()
    return this.originalTabTitlePromise
  }

  private async saveOriginalTabTitle(): Promise<void> {
    try {
      const title = await this.cli.currentTabTitle()
      if (title !== undefined)
        this.originalTabTitle = title
    }
    catch (error) {
      debug('TabTitleManager failed to save original tab title', errorMessage(error))
    }
    finally {
      this.originalTabTitleLoaded = true
      this.originalTabTitlePromise = undefined
    }
  }

  destroy(): Promise<void> {
    if (this.destroyed)
      return this.destroyPromise ?? Promise.resolve()
    this.destroyed = true
    this.clearDebounceTimer()
    this.clearRetryTimer()

    if (!this.enabled)
      return Promise.resolve()

    this.destroyPromise = this.restoreOriginalTabTitle()
      .catch(error => debug('TabTitleManager failed to restore original tab title', errorMessage(error)))
    return this.destroyPromise
  }

  private async restoreOriginalTabTitle(): Promise<void> {
    await this.originalTabTitlePromise
    await this.syncPromise
    const originalTitle = this.originalTabTitle
    this.originalTabTitle = undefined
    if (originalTitle === undefined)
      return
    await this.cli.renameTab(originalTitle)
  }
}
