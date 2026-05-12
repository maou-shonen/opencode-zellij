import type { PtySession } from '../pty/session.js'
import { describe, expect, it } from 'bun:test'
import { nextAdvice, publicSession } from './format.js'

function session(): PtySession {
  return {
    id: 'zpty_test',
    openCodeSessionId: 'opencode_session',
    paneId: 'terminal_1',
    title: 'test',
    command: 'bash',
    args: [],
    cwd: '/tmp',
    status: 'running',
    lineCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    allowAgentInput: true,
    humanInputOnly: false,
    exitCode: null,
    exitedAt: null,
    exitCodeToken: 'secret-token',
  }
}

describe('tool response formatting', () => {
  it('publishes only public session fields', () => {
    const output = publicSession(session())

    expect(output).toMatchObject({ id: 'zpty_test', paneId: 'terminal_1', agentWritable: true, lineCount: 3 })
    expect(output).not.toHaveProperty('exitCodeToken')
    expect(output).not.toHaveProperty('openCodeSessionId')
    expect(output).toHaveProperty('tombstone', null)
  })

  it('maps internal terminal sessions to the public exited status', () => {
    const terminal = session()
    terminal.status = 'terminal'
    terminal.tombstone = {
      reason: 'exit_marker',
      terminalAt: '2026-01-01T00:00:01.000Z',
      tail: [],
      paneClosedAt: null,
      notificationSentAt: null,
    }

    expect(publicSession(terminal).status).toBe('exited')
  })

  it('builds retry advice', () => {
    expect(nextAdvice(false, 'stop')).toEqual({ retryable: false, reason: 'stop' })
  })
})
