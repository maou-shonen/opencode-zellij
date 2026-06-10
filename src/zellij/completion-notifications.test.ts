import type { SubscriberTerminalEvent } from './completion-notifications.js'
import type { PtySession } from '../pty/session.js'
import { describe, expect, it } from 'bun:test'
import { SessionManager } from '../pty/manager.js'
import { buildCompletionPromptRequest, buildCompletionPromptText, SessionCompletionNotificationManager } from './completion-notifications.js'

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

function makeClient(overrides: { prompt?: (request: unknown) => Promise<unknown>, promptAsync?: (request: unknown) => Promise<unknown> }) {
  return {
    session: {
      prompt: overrides.prompt,
      promptAsync: overrides.promptAsync,
    },
  }
}

describe('completion notification manager', () => {
  it('fires the prompt the moment a pane exits', async () => {
    const prompts: unknown[] = []
    const manager = new SessionCompletionNotificationManager({
      client: makeClient({
        promptAsync: async (request: unknown) => {
          prompts.push(request)
        },
      }),
    })

    const session = createSession({ paneId: 'terminal_x' })
    session.exitCode = 0
    await manager.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(1)
    const req = prompts[0] as { sessionID: string, parts: Array<{ type: string, text: string }> }
    expect(req.sessionID).toBe(session.openCodeSessionId ?? '')
    expect(req.parts[0]?.type).toBe('text')
    expect(req.parts[0]?.text).toContain('[zellij_pty]')
    expect(req.parts[0]?.text).toContain('terminal_x')
    expect(req.parts[0]?.text).toContain('exit=0')
    expect(req.parts[0]?.text).toContain('zellij_pty_read')
    expect(req.parts[0]?.text).toContain('zellij_pty_kill')
    expect(prompts[0]).toEqual(buildCompletionPromptRequest(createEvent(session)))
  })

  it('falls back to client.session.prompt when promptAsync is unavailable', async () => {
    const prompts: unknown[] = []
    const manager = new SessionCompletionNotificationManager({
      client: makeClient({
        prompt: async (request: unknown) => {
          prompts.push(request)
        },
      }),
    })

    const session = createSession()
    await manager.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(1)
  })

  it('does nothing when the session has no OpenCode session id', async () => {
    const prompts: unknown[] = []
    const manager = new SessionCompletionNotificationManager({
      client: makeClient({
        promptAsync: async (request: unknown) => {
          prompts.push(request)
        },
      }),
    })

    const session = createSession()
    session.openCodeSessionId = null
    await manager.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(0)
  })

  it('does nothing when the client has no prompt or promptAsync', async () => {
    const manager = new SessionCompletionNotificationManager({ client: { session: {} } })
    const session = createSession()
    await expect(manager.handleSessionTerminal(createEvent(session))).resolves.toBeUndefined()
  })

  it('does nothing when the client has no session at all', async () => {
    const manager = new SessionCompletionNotificationManager({ client: {} })
    const session = createSession()
    await expect(manager.handleSessionTerminal(createEvent(session))).resolves.toBeUndefined()
  })

  it('catches and logs errors from the prompt call', async () => {
    const manager = new SessionCompletionNotificationManager({
      client: makeClient({
        promptAsync: async () => {
          const err = new Error('Request aborted') as Error & { name: string }
          err.name = 'MessageAbortedError'
          throw err
        },
      }),
    })

    const session = createSession()
    await expect(manager.handleSessionTerminal(createEvent(session))).resolves.toBeUndefined()
  })

  it('de-duplicates terminal events for the same plugin session id', async () => {
    const prompts: unknown[] = []
    const manager = new SessionCompletionNotificationManager({
      client: makeClient({
        promptAsync: async (request: unknown) => {
          prompts.push(request)
        },
      }),
    })

    const session = createSession()
    await manager.handleSessionTerminal(createEvent(session, 'exit_marker'))
    await manager.handleSessionTerminal(createEvent(session, 'pane_closed'))

    expect(prompts).toHaveLength(1)
  })

  it('builds the prompt text with pane id and exit code', () => {
    const withCode = createSession({ paneId: 'terminal_a' })
    withCode.exitCode = 7
    const noCode = createSession({ paneId: 'terminal_b' })

    expect(buildCompletionPromptText(createEvent(withCode))).toBe(
      '[zellij_pty] pane terminal_a exit=7 — call zellij_pty_read to read, then zellij_pty_kill to close.',
    )
    expect(buildCompletionPromptText(createEvent(noCode))).toBe(
      '[zellij_pty] pane terminal_b exit=? — call zellij_pty_read to read, then zellij_pty_kill to close.',
    )
  })

  it('dispose clears the seen set so the same session id can fire again', async () => {
    const prompts: unknown[] = []
    const manager = new SessionCompletionNotificationManager({
      client: makeClient({
        promptAsync: async (request: unknown) => {
          prompts.push(request)
        },
      }),
    })

    const session = createSession()
    await manager.handleSessionTerminal(createEvent(session))
    manager.dispose()
    await manager.handleSessionTerminal(createEvent(session))

    expect(prompts).toHaveLength(2)
  })
})
