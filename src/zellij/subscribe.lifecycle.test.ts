import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SessionManager } from '../pty/manager.js'
import { SubscriberManager } from './subscribe.js'

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdin = { end: () => {} }
  stdout = new FakeStream()
  stderr = new FakeStream()
  killed = false

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => {
      this.emit('exit', 0, null)
    })
    return true
  }
}

function createManager(
  spawned: FakeChild[],
  notifications: Array<{ sessionId: string, reason: string }>,
  options: {
    paneExists?: (paneId: string) => Promise<boolean | undefined>
  } = {},
): { manager: SubscriberManager, sessions: SessionManager } {
  const sessions = new SessionManager()
  const manager = new SubscriberManager(sessions, 10, {
    spawn: () => {
      const child = new FakeChild()
      spawned.push(child)
      return child as any
    },
    dumpScreen: async () => 'boot line',
    paneExists: options.paneExists ?? (async () => true),
    closePane: async () => {},
    terminalTailLines: 2,
    lifecycleHooks: {
      onSessionTerminal: event => {
        notifications.push({ sessionId: event.sessionId, reason: event.reason })
      },
    },
  })
  return { manager, sessions }
}

async function waitFor(assertion: () => void, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    }
    catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  if (lastError)
    throw lastError
  assertion()
}

describe('SubscriberManager lifecycle handling', () => {
  const originalZellij = process.env.ZELLIJ

  beforeEach(() => {
    process.env.ZELLIJ = '1'
  })

  afterEach(() => {
    if (originalZellij === undefined)
      delete process.env.ZELLIJ
    else
      process.env.ZELLIJ = originalZellij
  })

  it('captures exit markers and marks the session terminal once', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications)
    const session = sessions.create({
      paneId: 'terminal_1',
      title: 'exit',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
      exitCodeToken: 'abc123',
    })

    await manager.start(session)
    spawned[0]!.stdout.emit('data', `${JSON.stringify({ viewport: ['line 1', '[zellij-pty:abc123] exit-code=7'] })}\n`)

    const updated = sessions.get(session.id)
    expect(updated.status).toBe('terminal')
    expect(updated.exitCode).toBe(7)
    expect(updated.tombstone?.reason).toBe('exit_marker')
    expect(updated.tombstone?.tail.at(-1)).toContain('exit-code=7')
    expect(notifications).toEqual([{ sessionId: session.id, reason: 'exit_marker' }])
  })

  it('marks pane_closed sessions terminal without reviving them', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications)
    const session = sessions.create({
      paneId: 'terminal_2',
      title: 'pane closed',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    spawned[0]!.stdout.emit('data', `${JSON.stringify({ event: 'pane_closed', pane_id: session.paneId })}\n`)

    const updated = sessions.get(session.id)
    expect(updated.status).toBe('terminal')
    expect(updated.tombstone?.reason).toBe('pane_closed')
    expect(notifications).toEqual([{ sessionId: session.id, reason: 'pane_closed' }])
  })

  it('marks sessions terminal when the subscriber exits after the pane is gone', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications, {
      paneExists: async () => false,
    })
    const session = sessions.create({
      paneId: 'terminal_3',
      title: 'subscriber exit',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    spawned[0]!.emit('exit', 0, null)

    await waitFor(() => {
      const updated = sessions.get(session.id)
      expect(updated.status).toBe('terminal')
      expect(updated.tombstone?.reason).toBe('subscriber_exit')
      expect(notifications).toEqual([{ sessionId: session.id, reason: 'subscriber_exit' }])
    })
  })

  it('marks sessions terminal when the subscriber errors after the pane is gone', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications, {
      paneExists: async () => false,
    })
    const session = sessions.create({
      paneId: 'terminal_4',
      title: 'subscriber error',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    spawned[0]!.emit('error', new Error('subscribe failed'))

    await waitFor(() => {
      const updated = sessions.get(session.id)
      expect(updated.status).toBe('terminal')
      expect(updated.tombstone?.reason).toBe('subscriber_error')
      expect(notifications).toEqual([{ sessionId: session.id, reason: 'subscriber_error' }])
    })
  })

  it('does not misreport completion when the subscriber exits but the pane still exists', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications, {
      paneExists: async () => true,
    })
    const session = sessions.create({
      paneId: 'terminal_5',
      title: 'pane still exists',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    spawned[0]!.emit('exit', 0, null)
    await new Promise(resolve => setTimeout(resolve, 10))

    const updated = sessions.get(session.id)
    expect(updated.status).toBe('running')
    expect(updated.tombstone).toBeNull()
    expect(notifications).toEqual([])
  })

  it('keeps sessions non-terminal and records diagnostics when pane verification is inconclusive', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications, {
      paneExists: async () => undefined,
    })
    const session = sessions.create({
      paneId: 'terminal_6',
      title: 'pane unknown',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    spawned[0]!.emit('exit', 0, null)

    await waitFor(() => {
      expect(manager.stderr(session.id).join('\n')).toContain('could not confirm whether pane terminal_6 still exists')
    })

    const updated = sessions.get(session.id)
    expect(updated.status).toBe('running')
    expect(updated.tombstone).toBeNull()
    expect(notifications).toEqual([])
  })

  it('keeps sessions non-terminal and records diagnostics when pane verification fails', async () => {
    const spawned: FakeChild[] = []
    const notifications: Array<{ sessionId: string; reason: string }> = []
    const { manager, sessions } = createManager(spawned, notifications, {
      paneExists: async () => {
        throw new Error('list-panes unavailable')
      },
    })
    const session = sessions.create({
      paneId: 'terminal_7',
      title: 'pane verification failed',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    spawned[0]!.emit('error', new Error('subscribe failed'))

    await waitFor(() => {
      expect(manager.stderr(session.id).join('\n')).toContain('could not verify pane terminal_7: list-panes unavailable')
    })

    const updated = sessions.get(session.id)
    expect(updated.status).toBe('unknown')
    expect(updated.tombstone).toBeNull()
    expect(notifications).toEqual([])
  })
})
