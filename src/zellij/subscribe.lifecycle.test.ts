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

function createManager(spawned: FakeChild[], notifications: Array<{ sessionId: string; reason: string }>): { manager: SubscriberManager, sessions: SessionManager } {
  const sessions = new SessionManager()
  const manager = new SubscriberManager(sessions, 10, {
    spawn: () => {
      const child = new FakeChild()
      spawned.push(child)
      return child as any
    },
    dumpScreen: async () => 'boot line',
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
})
