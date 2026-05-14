import type { SessionStatus as OpenCodeSessionStatus } from '@opencode-ai/sdk'
import type { CompletionNotificationConfig } from '../config.js'
import type { PtySession, SessionTerminalReason } from '../pty/session.js'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

interface PromptIdleStatusClient {
  session?: {
    status?: (options: { query: { directory: string } }) => Promise<unknown>
  }
}

/** Fetches the prompt-mode idle guard status; unrelated to tab title state. */
async function fetchPromptIdleStatusSnapshot(
  client: PromptIdleStatusClient,
  workspaceRoot: string,
): Promise<Record<string, OpenCodeSessionStatus> | undefined> {
  try {
    if (!client.session?.status) {
      debug('fetchPromptIdleStatusSnapshot: client.session.status not available')
      return undefined
    }

    const result = await client.session.status({ query: { directory: workspaceRoot } })
    const payload = result && typeof result === 'object' && 'data' in result
      ? (result as { data: unknown }).data
      : result

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      debug('fetchPromptIdleStatusSnapshot received non-object payload')
      return undefined
    }

    const entries = Object.entries(payload)
    if (entries.length === 0)
      return {}

    const snapshot: Record<string, OpenCodeSessionStatus> = {}
    for (const [sessionID, status] of entries) {
      const parsed = parseSessionStatus(status)
      if (parsed === undefined) {
        debug('fetchPromptIdleStatusSnapshot received invalid status entry, rejecting entire snapshot')
        return undefined
      }
      snapshot[sessionID] = parsed
    }

    return snapshot
  }
  catch (err) {
    debug('fetchPromptIdleStatusSnapshot failed', errorMessage(err))
    return undefined
  }
}

function parseSessionStatus(value: unknown): OpenCodeSessionStatus | undefined {
  if (!value || typeof value !== 'object' || !('type' in value))
    return undefined

  const status = value as Record<string, unknown>
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

export interface CompletionNotificationToastClient {
  tui?: {
    showToast?: (options: {
      body: {
        title: string
        message: string
        variant: 'success' | 'error'
        duration: number
      }
    }) => Promise<unknown>
  }
}

export interface CompletionNotificationPromptClient {
  session?: {
    status?: (options: { query: { directory: string } }) => Promise<unknown>
    prompt?: (request: CompletionPromptRequest) => Promise<unknown>
    promptAsync?: (request: CompletionPromptRequest) => Promise<unknown>
  }
}

export interface CompletionNotificationClient extends CompletionNotificationToastClient, CompletionNotificationPromptClient {}

export interface CompletionNotificationContext {
  client: CompletionNotificationClient
  workspaceRoot: string
  config: CompletionNotificationConfig
  markSent: (sessionId: string) => void
}

export interface CompletionNotificationHooks {
  prompt?: (event: SubscriberTerminalEvent) => void | Promise<void>
}

export interface CompletionNotificationManager {
  handleSessionTerminal: (event: SubscriberTerminalEvent) => Promise<void>
  injectQueuedChatMessage: (input: unknown) => unknown
  clearSession: (sessionId: string) => void
  clearAll: () => void
  dispose: () => void
}

export interface SubscriberTerminalEvent {
  sessionId: string
  reason: SessionTerminalReason
  session: PtySession
}

export interface CompletionPromptRequest {
  path: {
    id: string
  }
  body: {
    parts: Array<{
      type: 'text'
      text: string
    }>
  }
}

interface CompletionNotificationState {
  event: SubscriberTerminalEvent
  queued: boolean
  toastSent: boolean
  promptAttempts: number
  promptAttemptedAt: number | null
}

interface CompletionNotificationDecision {
  shouldPrompt: boolean
  shouldQueue: boolean
  reason: string
}

const completionTitle = 'Zellij PTY session completed'
const completionMessage = 'A Zellij PTY session completed. Review the finished pane if needed.'
const queuedNoticeHeader = '[OpenCode] Zellij PTY completion notice'

export function buildQueuedCompletionNotice(events: SubscriberTerminalEvent[]): string {
  const lines = events.map(event => `- ${event.session.id} (${event.session.paneId}) 已完成，請使用 zellij_pty_read 讀取最終輸出並清理 pane。`)
  return [queuedNoticeHeader, ...lines].join('\n')
}

export function buildCompletionPromptRequest(event: SubscriberTerminalEvent): CompletionPromptRequest {
  return {
    path: {
      id: event.session.openCodeSessionId!,
    },
    body: {
      parts: [{ type: 'text', text: completionMessage }],
    },
  }
}

export function injectQueuedCompletionNotice(input: unknown, notice: string): unknown {
  if (typeof input === 'string')
    return `${notice}\n\n${input}`

  if (!input || typeof input !== 'object')
    return input

  const record = input as Record<string, unknown>

  if (Array.isArray(record.parts)) {
    return {
      ...record,
      parts: [{ type: 'text', text: notice }, ...record.parts],
    }
  }

  if (typeof record.message === 'string') {
    return {
      ...record,
      message: `${notice}\n\n${record.message}`,
    }
  }

  if (typeof record.content === 'string') {
    return {
      ...record,
      content: `${notice}\n\n${record.content}`,
    }
  }

  if (typeof record.text === 'string') {
    return {
      ...record,
      text: `${notice}\n\n${record.text}`,
    }
  }

  return {
    ...record,
    message: notice,
  }
}

export function evaluateCompletionPromptDecision(input: {
  event: SubscriberTerminalEvent
  config: Pick<CompletionNotificationConfig, 'mode' | 'prompt'>
  snapshot?: Record<string, OpenCodeSessionStatus> | undefined
  snapshotAvailable: boolean
  now: number
  lastPromptAttemptAt: number | null
  promptAttemptCount: number
  promptClientAvailable: boolean
}): CompletionNotificationDecision {
  if (input.config.mode !== 'prompt')
    return { shouldPrompt: false, shouldQueue: false, reason: 'prompt mode disabled' }

  if (input.event.session.humanInputOnly || !input.event.session.allowAgentInput)
    return { shouldPrompt: false, shouldQueue: true, reason: 'human-input-only session' }

  if (!input.promptClientAvailable)
    return { shouldPrompt: false, shouldQueue: true, reason: 'prompt client unavailable' }

  if (!input.event.session.openCodeSessionId)
    return { shouldPrompt: false, shouldQueue: true, reason: 'session id unavailable' }

  if (!input.snapshotAvailable)
    return { shouldPrompt: false, shouldQueue: true, reason: 'session status snapshot unavailable' }

  if (input.config.prompt.maxAttempts <= 0 || input.promptAttemptCount >= input.config.prompt.maxAttempts)
    return { shouldPrompt: false, shouldQueue: true, reason: 'prompt max attempts reached' }

  if (input.config.prompt.cooldownMs > 0 && input.lastPromptAttemptAt !== null && input.now - input.lastPromptAttemptAt < input.config.prompt.cooldownMs)
    return { shouldPrompt: false, shouldQueue: true, reason: 'prompt cooldown active' }

  if (input.config.prompt.requireIdle) {
    const sessionId = input.event.session.openCodeSessionId
    if (!sessionId)
      return { shouldPrompt: false, shouldQueue: true, reason: 'session status unavailable' }
    const status = sessionId ? input.snapshot?.[sessionId] : undefined
    if (!status)
      return { shouldPrompt: false, shouldQueue: true, reason: 'session status unavailable' }
    if (status && status.type !== 'idle')
      return { shouldPrompt: false, shouldQueue: true, reason: 'session not idle' }
  }

  return { shouldPrompt: true, shouldQueue: false, reason: 'prompt allowed' }
}

export class SessionCompletionNotificationQueue implements CompletionNotificationManager {
  private readonly states = new Map<string, CompletionNotificationState>()

  constructor(
    private readonly context: CompletionNotificationContext,
    private readonly hooks: CompletionNotificationHooks = {},
    private readonly clock: () => number = () => Date.now(),
  ) {}

  hasPending(sessionId: string): boolean {
    return this.states.get(sessionId)?.queued ?? false
  }

  clearSession(sessionId: string): void {
    this.states.delete(sessionId)
  }

  clearAll(): void {
    this.states.clear()
  }

  dispose(): void {
    this.clearAll()
  }

  async handleSessionTerminal(event: SubscriberTerminalEvent): Promise<void> {
    if (this.context.config.mode === 'off')
      return

    if (this.states.has(event.sessionId) || event.session.tombstone?.notificationSentAt)
      return

    const state: CompletionNotificationState = {
      event,
      queued: false,
      toastSent: false,
      promptAttempts: 0,
      promptAttemptedAt: null,
    }

    this.states.set(event.sessionId, state)

    switch (this.context.config.mode) {
      case 'queue':
        state.queued = true
        return
      case 'toast':
        await this.sendToast(state)
        this.finalize(state)
        return
      case 'queue+toast':
        state.queued = true
        await this.sendToast(state)
        return
      case 'prompt':
        await this.tryPromptOrQueue(state)
        break
      default:
    }
  }

  injectQueuedChatMessage(input: unknown): unknown {
    const pending = [...this.states.values()].filter(state => state.queued)
    if (pending.length === 0)
      return input

    const notice = buildQueuedCompletionNotice(pending.map(state => state.event))
    for (const state of pending) {
      if (!state.toastSent)
        this.context.markSent(state.event.sessionId)
      this.finalize(state)
    }

    return injectQueuedCompletionNotice(input, notice)
  }

  private async tryPromptOrQueue(state: CompletionNotificationState): Promise<void> {
    if (!state.event.session.openCodeSessionId) {
      state.queued = true
      return
    }

    const session = this.context.client.session
    const prompt = session?.prompt ?? session?.promptAsync
    const statusSnapshot = await fetchPromptIdleStatusSnapshot(this.context.client, this.context.workspaceRoot)
    const decision = evaluateCompletionPromptDecision({
      event: state.event,
      config: this.context.config,
      snapshot: statusSnapshot,
      snapshotAvailable: statusSnapshot !== undefined,
      now: this.clock(),
      lastPromptAttemptAt: state.promptAttemptedAt,
      promptAttemptCount: state.promptAttempts,
      promptClientAvailable: Boolean(prompt),
    })

    if (!decision.shouldPrompt) {
      state.queued = decision.shouldQueue
      return
    }

    if (this.hooks.prompt) {
      try {
        const maybePromise = this.hooks.prompt(state.event)
        if (maybePromise && typeof maybePromise.then === 'function')
          await maybePromise
      }
      catch (error) {
        debug('completion notification prompt hook failed', errorMessage(error))
      }
    }

    if (!session || !prompt) {
      state.queued = true
      return
    }

    state.promptAttempts += 1
    state.promptAttemptedAt = this.clock()

    try {
      if (session.prompt) {
        await session.prompt(buildCompletionPromptRequest(state.event))
      }
      else if (session.promptAsync) {
        await session.promptAsync(buildCompletionPromptRequest(state.event))
      }
      else {
        state.queued = true
        return
      }
      this.context.markSent(state.event.sessionId)
      this.finalize(state)
    }
    catch (error) {
      debug('completion notification prompt failed', errorMessage(error))
      state.queued = true
    }
  }

  private async sendToast(state: CompletionNotificationState): Promise<void> {
    const toast = this.context.client.tui?.showToast
    if (!toast) {
      debug('completion notification toast skipped: client.tui.showToast unavailable')
      return
    }

    try {
      await toast({
        body: {
          title: completionTitle,
          message: completionMessage,
          variant: 'success',
          duration: 10_000,
        },
      })
      state.toastSent = true
      this.context.markSent(state.event.sessionId)
      if (!state.queued)
        this.finalize(state)
    }
    catch (error) {
      debug('completion notification toast failed', errorMessage(error))
    }
  }

  private finalize(state: CompletionNotificationState): void {
    this.states.delete(state.event.sessionId)
  }
}
