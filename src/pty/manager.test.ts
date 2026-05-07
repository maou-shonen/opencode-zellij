import { describe, expect, it } from 'bun:test'
import { SessionManager } from './manager.js'

describe('SessionManager', () => {
  it('creates and lists sessions', () => {
    const manager = new SessionManager()
    const session = manager.create({
      openCodeSessionId: 'session_a',
      paneId: 'terminal_1',
      title: 'dev',
      command: 'npm run dev',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    expect(session.id).toMatch(/^zpty_/)
    expect(session.openCodeSessionId).toBe('session_a')
    expect(manager.list()).toHaveLength(1)
    expect(manager.get(session.id).paneId).toBe('terminal_1')
  })

  it('updates status without removing the session', () => {
    const manager = new SessionManager()
    const session = manager.create({
      paneId: 'terminal_2',
      title: 'worker',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: false,
      humanInputOnly: true,
    })

    manager.updateStatus(session.id, 'killed')
    expect(manager.get(session.id).status).toBe('killed')
  })

  it('lists sessions by OpenCode session id', () => {
    const manager = new SessionManager()
    const first = manager.create({
      openCodeSessionId: 'session_a',
      paneId: 'terminal_1',
      title: 'first',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })
    manager.create({
      openCodeSessionId: 'session_b',
      paneId: 'terminal_2',
      title: 'second',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    expect(manager.listByOpenCodeSession('session_a')).toEqual([first])
  })

  it('captures exit codes', () => {
    const manager = new SessionManager()
    const session = manager.create({
      paneId: 'terminal_4',
      title: 'exit',
      command: 'exit 7',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
      exitCodeToken: 'abc123',
    })

    const updated = manager.markExited(session.id, 7)
    expect(updated.status).toBe('exited')
    expect(updated.exitCode).toBe(7)
    expect(updated.exitedAt).toBeTruthy()
  })

  it('removes sessions and rejects unknown ids', () => {
    const manager = new SessionManager()
    const session = manager.create({
      paneId: 'terminal_5',
      title: 'remove',
      command: 'bash',
      cwd: '/tmp/project',
      allowAgentInput: true,
      humanInputOnly: false,
    })

    manager.remove(session.id)
    expect(manager.list()).toEqual([])
    expect(() => manager.get(session.id)).toThrow(/Unknown zellij PTY session/)
    expect(() => manager.remove(session.id)).toThrow(/Unknown zellij PTY session/)
  })
})
