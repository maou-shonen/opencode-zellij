import type { CompletionNotificationClient, CompletionPromptRequest, SubscriberTerminalEvent } from './completion-notifications.js'
import type { CompletionNotificationConfig } from '../config.js'
import type { PtySession } from '../pty/session.js'
import { describe, expect, it } from 'bun:test'
import { SessionManager } from '../pty/manager.js'
import { buildCompletionPromptRequest, buildQueuedCompletionNotice, evaluateCompletionPromptDecision, SessionCompletionNotificationQueue } from './completion-notifications.js'

function createSession(overrides: Partial<PtySession> = {}): PtySession {
  const manager = new SessionManager()
  return manager.create({
    openCodeSessionId: overrides.openCodeSessionId ?? 'oc_1',
    paneId: overrides.paneId ?? 'terminal_1',
    title: overrides.title ?? 'demo',
    command: overrides.command ?? 'bash',
    args: overrides.args ?? [],
    cwd: overrides.cwd ?? '/tmp/project',
    allowAgentInput: overrides.allowAgentInput ?? true,
    humanInputOnly: overrides.humanInputOnly ?? false,
    exitCodeToken: overrides.exitCodeToken ?? undefined,
  })
}

function createEvent(session: PtySession, reason: SubscriberTerminalEvent['reason'] = 'exit_marker'): SubscriberTerminalEvent {
  return { sessionId: session.id, reason, session }
}

function createHarness(config: CompletionNotificationConfig, options: {
  statusResponse?: unknown
  promptBehavior?: 'resolve' | 'reject'
  usePromptAsync?: boolean
} = {}) {
  const toasts: unknown[] = []
  const prompts: CompletionPromptRequest[] = []
  const promptThisValues: unknown[] = []
  const marks: string[] = []
  const session = createSession()
  const client: CompletionNotificationClient = {
    tui: {
      showToast: async (payload) => {
        toasts.push(payload)
      },
    },
  }

  const sessionClient: NonNullable<CompletionNotificationClient['session']> = {}
  if (options.statusResponse !== undefined)
    sessionClient.status = async () => options.statusResponse
  if (!options.usePromptAsync) {
    sessionClient.prompt = async function (request) {
      prompts.push(request)
      promptThisValues.push(this)
      if (options.promptBehavior === 'reject')
        throw new Error('prompt rejected')
    }
  }
  else {
    sessionClient.promptAsync = async function (request) {
      prompts.push(request)
      promptThisValues.push(this)
      if (options.promptBehavior === 'reject')
        throw new Error('prompt rejected')
    }
  }
  client.session = sessionClient

  const queue = new SessionCompletionNotificationQueue({
    client,
    workspaceRoot: '/tmp/project',
    config,
    markSent: sessionId => marks.push(sessionId),
  })

  return { queue, session, toasts, prompts, marks, client, sessionClient, promptThisValues }
}

describe('completion notifications', () => {
  it('queues completions and injects them into the next chat message once', async () => {
    const { queue, session, toasts, prompts, marks } = createHarness({
      mode: 'queue',
      prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
    })

    await queue.handleSessionTerminal(createEvent(session))

    expect(queue.hasPending(session.id)).toBe(true)
    expect(toasts).toHaveLength(0)
    expect(prompts).toHaveLength(0)

    const injected = queue.injectQueuedChatMessage({ message: 'hello' }) as { message: string }
    expect(injected.message).toContain('[OpenCode] Zellij PTY completion notice')
    expect(injected.message).toContain(`${session.id} (terminal_1) 已完成`)
    expect(queue.hasPending(session.id)).toBe(false)
    expect(marks).toEqual([session.id])

    const second = queue.injectQueuedChatMessage({ message: 'world' }) as { message: string }
    expect(second.message).toBe('world')
  })

  it('shows a toast without queueing or prompting', async () => {
    const { queue, session, toasts, prompts } = createHarness({
      mode: 'toast',
      prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
    })

    await queue.handleSessionTerminal(createEvent(session))

    expect(toasts).toHaveLength(1)
    expect(prompts).toHaveLength(0)
    expect(queue.hasPending(session.id)).toBe(false)
  })

  it('actively prompts before toast delivery and skips later queued injection when queue+toast can prompt', async () => {
    const { queue, session, toasts, prompts, marks } = createHarness(
      {
        mode: 'queue+toast',
        prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
      },
      { statusResponse: { data: { oc_1: { type: 'idle' } } } },
    )

    await queue.handleSessionTerminal(createEvent(session))

    expect(toasts).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(queue.hasPending(session.id)).toBe(false)
    expect(marks).toEqual([session.id])

    const injected = queue.injectQueuedChatMessage({ message: 'hello' }) as { message: string }
    expect(injected.message).toBe('hello')
  })

  it('keeps the queued notice when queue+toast prompt delivery is blocked by the idle guard', async () => {
    const { queue, session, toasts, prompts, marks } = createHarness({
      mode: 'queue+toast',
      prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
    }, { statusResponse: { data: { oc_1: { type: 'busy' } } } })

    await queue.handleSessionTerminal(createEvent(session))

    expect(toasts).toHaveLength(1)
    expect(prompts).toHaveLength(0)
    expect(queue.hasPending(session.id)).toBe(true)
    expect(marks).toEqual([session.id])

    const injected = queue.injectQueuedChatMessage({ message: 'hello' }) as { message: string }
    expect(injected.message).toContain('[OpenCode] Zellij PTY completion notice')
    expect(queue.hasPending(session.id)).toBe(false)
  })

  it('keeps the queued notice when queue+toast prompt delivery is unavailable or fails', async () => {
    const unavailable = createHarness({
      mode: 'queue+toast',
      prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
    }, { statusResponse: { data: { oc_1: { type: 'idle' } } } })

    unavailable.client.session = unavailable.sessionClient.status
      ? { status: unavailable.sessionClient.status }
      : {}

    await unavailable.queue.handleSessionTerminal(createEvent(unavailable.session))

    expect(unavailable.prompts).toHaveLength(0)
    expect(unavailable.toasts).toHaveLength(1)
    expect(unavailable.queue.hasPending(unavailable.session.id)).toBe(true)

    const rejected = createHarness(
      {
        mode: 'queue+toast',
        prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
      },
      { statusResponse: { data: { oc_1: { type: 'idle' } } }, promptBehavior: 'reject' },
    )

    await rejected.queue.handleSessionTerminal(createEvent(rejected.session))

    expect(rejected.prompts).toHaveLength(1)
    expect(rejected.toasts).toHaveLength(1)
    expect(rejected.queue.hasPending(rejected.session.id)).toBe(true)

    const injected = rejected.queue.injectQueuedChatMessage({ message: 'hello' }) as { message: string }
    expect(injected.message).toContain('[OpenCode] Zellij PTY completion notice')
  })

  it('prompts directly when the guard passes and uses the SDK prompt request shape', async () => {
    const { queue, session, toasts, prompts, marks, client, sessionClient, promptThisValues } = createHarness(
      {
        mode: 'prompt',
        prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
      },
      { statusResponse: { data: { oc_1: { type: 'idle' } }, }, usePromptAsync: true },
    )

    await queue.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(0)
    expect(queue.hasPending(session.id)).toBe(false)
    expect(marks).toEqual([session.id])

    const payload = prompts[0]!
    expect(payload).toEqual(buildCompletionPromptRequest(createEvent(session)))
    expect(payload).not.toHaveProperty('title')
    expect(payload).not.toHaveProperty('message')
    expect(payload.body).not.toHaveProperty('title')
    expect(payload.body).not.toHaveProperty('message')
    expect(payload.body).not.toHaveProperty('details')
    expect(payload.path.id).toBe(session.openCodeSessionId ?? 'oc_1')
    expect(payload.body.parts).toEqual([{ type: 'text', text: 'A Zellij PTY session completed. Review the finished pane if needed.' }])
    expect(promptThisValues[0]).toBe(sessionClient)
    expect(client.session).toBe(sessionClient)
  })

  it('queues prompt completions when the OpenCode session id is missing', async () => {
    const { queue, session, toasts, prompts } = createHarness({
      mode: 'prompt',
      prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
    })
    session.openCodeSessionId = null

    await queue.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(0)
    expect(toasts).toHaveLength(0)
    expect(queue.hasPending(session.id)).toBe(true)
  })

  it('falls back to queue when prompt is rejected', async () => {
    const { queue, session, prompts } = createHarness(
      {
        mode: 'prompt',
        prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 },
      },
      { statusResponse: { data: { oc_1: { type: 'idle' } } }, promptBehavior: 'reject', usePromptAsync: true },
    )

    await queue.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(1)
    expect(queue.hasPending(session.id)).toBe(true)
    const injected = queue.injectQueuedChatMessage({ message: 'hello' }) as { message: string }
    expect(injected.message).toContain('[OpenCode] Zellij PTY completion notice')
  })

  it('respects prompt guards and falls back to queue when idle check fails', () => {
    const session = createSession()
    const event = createEvent(session)

    expect(evaluateCompletionPromptDecision({
      event,
      config: { mode: 'prompt', prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 } },
      snapshotAvailable: true,
      snapshot: { oc_1: { type: 'busy' } },
      now: 1_000,
      lastPromptAttemptAt: null,
      promptAttemptCount: 0,
      promptClientAvailable: true,
    })).toEqual({ shouldPrompt: false, shouldQueue: true, reason: 'session not idle' })

    expect(evaluateCompletionPromptDecision({
      event,
      config: { mode: 'prompt', prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 } },
      snapshotAvailable: false,
      snapshot: undefined,
      now: 1_000,
      lastPromptAttemptAt: null,
      promptAttemptCount: 0,
      promptClientAvailable: true,
    })).toEqual({ shouldPrompt: false, shouldQueue: true, reason: 'session status snapshot unavailable' })

    const missingIdSession = createSession()
    missingIdSession.openCodeSessionId = null

    expect(evaluateCompletionPromptDecision({
      event: createEvent(missingIdSession),
      config: { mode: 'prompt', prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 } },
      snapshotAvailable: true,
      snapshot: { oc_1: { type: 'idle' } },
      now: 1_000,
      lastPromptAttemptAt: null,
      promptAttemptCount: 0,
      promptClientAvailable: true,
    })).toEqual({ shouldPrompt: false, shouldQueue: true, reason: 'session id unavailable' })

    expect(evaluateCompletionPromptDecision({
      event,
      config: { mode: 'prompt', prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 } },
      snapshotAvailable: true,
      snapshot: { oc_1: { type: 'idle' } },
      now: 1_000,
      lastPromptAttemptAt: 900,
      promptAttemptCount: 0,
      promptClientAvailable: true,
    })).toEqual({ shouldPrompt: false, shouldQueue: true, reason: 'prompt cooldown active' })

    expect(evaluateCompletionPromptDecision({
      event,
      config: { mode: 'prompt', prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 0 } },
      snapshotAvailable: true,
      snapshot: { oc_1: { type: 'idle' } },
      now: 1_000,
      lastPromptAttemptAt: null,
      promptAttemptCount: 0,
      promptClientAvailable: true,
    })).toEqual({ shouldPrompt: false, shouldQueue: true, reason: 'prompt max attempts reached' })

    expect(evaluateCompletionPromptDecision({
      event: createEvent(createSession({ humanInputOnly: true, allowAgentInput: false })),
      config: { mode: 'prompt', prompt: { requireIdle: true, cooldownMs: 30_000, maxAttempts: 1 } },
      snapshotAvailable: true,
      snapshot: { oc_1: { type: 'idle' } },
      now: 1_000,
      lastPromptAttemptAt: null,
      promptAttemptCount: 0,
      promptClientAvailable: true,
    })).toEqual({ shouldPrompt: false, shouldQueue: true, reason: 'human-input-only session' })
  })

  it('builds fixed prompt and queue templates without output or tail data', () => {
    const session = createSession()
    const event = createEvent(session)

    expect(buildCompletionPromptRequest(event)).toEqual({
      path: { id: session.openCodeSessionId ?? 'oc_1' },
      body: {
        parts: [{ type: 'text', text: 'A Zellij PTY session completed. Review the finished pane if needed.' }],
      },
    })

    expect(buildQueuedCompletionNotice([event])).toContain('[OpenCode] Zellij PTY completion notice')
    expect(buildQueuedCompletionNotice([event])).toContain(`${session.id} (terminal_1) 已完成`)
    expect(buildQueuedCompletionNotice([event])).not.toContain(session.command)
  })
})
