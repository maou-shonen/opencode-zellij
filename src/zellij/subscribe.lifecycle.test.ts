import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SessionManager } from '../pty/manager.js'
import { zellij } from '../lib/zellij/cli.js'
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
    spawn?: (...args: any[]) => any
  } = {},
): { manager: SubscriberManager, sessions: SessionManager } {
  const sessions = new SessionManager()
  const manager = new SubscriberManager(sessions, 10, {
    spawn: options.spawn ?? (() => {
      const child = new FakeChild()
      spawned.push(child)
      return child as any
    }),
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

  it('preserves zellij.closePane binding during session cleanup', async () => {
    const originalClosePane = zellij.closePane
    const closeCalls: string[] = []
    ;(zellij as any).closeCalls = closeCalls
    zellij.closePane = async function (this: { closeCalls: string[] }, paneId: string): Promise<void> {
      this.closeCalls.push(paneId)
    }

    try {
      const sessions = new SessionManager()
      const manager = new SubscriberManager(sessions, 10, {
        spawn: () => new FakeChild() as any,
        dumpScreen: async () => 'boot line',
        paneExists: async () => true,
      })
      const session = sessions.create({
        paneId: 'terminal_8',
        title: 'cleanup binding',
        command: 'bash',
        cwd: '/tmp/project',
        allowAgentInput: true,
        humanInputOnly: false,
      })

      await manager.closeSessionPane(session.id)

      expect(closeCalls).toEqual(['terminal_8'])
    }
    finally {
      zellij.closePane = originalClosePane
      delete (zellij as any).closeCalls
    }
  })

  it('spawns the subscribe child without --scrollback to avoid zellij 0.44.x initial-event stalls', async () => {
    const spawnCalls: Array<{ command: string, args: readonly string[] | undefined }> = []
    const sessions = new SessionManager()
    const manager = new SubscriberManager(sessions, 10, {
      spawn: ((command: string, args?: readonly string[]) => {
        spawnCalls.push({ command, args })
        return new FakeChild() as any
      }) as (...args: any[]) => any,
      dumpScreen: async () => 'boot line',
      paneExists: async () => true,
    })
    const session = sessions.create({
      paneId: 'terminal_9',
      title: 'no scrollback flag',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.command).toBe('zellij')
    // Bare `--scrollback` on zellij 0.44.x triggers a burst-then-stall
    // delivery of the initial scrollback event; the subscriber child stays
    // alive for the duration and `subscriberManager.start()` blocks with it,
    // which makes every `zellij_pty_read` / `zellij_pty_spawn` look like a
    // frozen pane. The plugin already captures the canonical scrollback
    // via `dump-screen --full` right after, so we don't need it here.
    expect(spawnCalls[0]!.args ?? []).not.toContain('--scrollback')
    expect(spawnCalls[0]!.args ?? []).toEqual(expect.arrayContaining([
      'subscribe',
      '--pane-id', 'terminal_9',
      '--format', 'json',
      '--ansi',
    ]))
  })

  it('still buffers viewport-only events when the initial event carries no scrollback', async () => {
    const spawned: FakeChild[] = []
    const sessions = new SessionManager()
    const manager = new SubscriberManager(sessions, 10, {
      spawn: () => {
        const child = new FakeChild()
        spawned.push(child)
        return child as any
      },
      dumpScreen: async () => 'snapshot-line-1\nsnapshot-line-2',
      paneExists: async () => true,
    })
    const session = sessions.create({
      paneId: 'terminal_10',
      title: 'viewport only initial',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    await manager.start(session)
    expect(spawned[0]).toBeDefined()
    // Simulate the initial event shape we now actually receive from zellij
    // without `--scrollback`: `scrollback` is null/absent, only `viewport`.
    spawned[0]!.stdout.emit('data', `${JSON.stringify({
      event: 'pane_update',
      is_initial: true,
      pane_id: 'terminal_10',
      viewport: ['line-a', 'line-b'],
    })}\n`)

    const read = manager.read(session.id, { limit: 100 })
    expect(read.lines).toContain('snapshot-line-1')
    expect(read.lines).toContain('snapshot-line-2')
    expect(read.lines).toContain('line-a')
    expect(read.lines).toContain('line-b')
  })
})
