import type { PtySession } from '../pty/session.js'
import { describe, expect, it } from 'bun:test'
import { publicSession } from './format.js'

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
  it('publishes only the lean public session fields by default', () => {
    const output = publicSession(session())

    expect(output).toEqual({
      id: 'zpty_test',
      paneId: 'terminal_1',
      title: 'test',
      command: 'bash',
      status: 'running',
    })
    expect(output).not.toHaveProperty('exitCodeToken')
    expect(output).not.toHaveProperty('openCodeSessionId')
    expect(output).not.toHaveProperty('args')
    expect(output).not.toHaveProperty('cwd')
    expect(output).not.toHaveProperty('lineCount')
    expect(output).not.toHaveProperty('createdAt')
    expect(output).not.toHaveProperty('updatedAt')
    expect(output).not.toHaveProperty('agentWritable')
    expect(output).not.toHaveProperty('humanInputOnly')
    expect(output).not.toHaveProperty('tombstone')
  })

  it('only surfaces humanInputOnly when the pane rejects agent writes', () => {
    const defaultView = publicSession(session())
    expect(defaultView).not.toHaveProperty('humanInputOnly')

    const sudoView = publicSession(session(), { agentWritable: false })
    expect(sudoView.humanInputOnly).toBe(true)
  })

  it('omits tombstone unless includeTombstone is requested', () => {
    expect(publicSession(session())).not.toHaveProperty('tombstone')

    const exited = session()
    exited.status = 'exited'
    exited.tombstone = {
      reason: 'exit_marker',
      terminalAt: '2026-01-01T00:00:01.000Z',
      tail: [],
      paneClosedAt: null,
    }

    const summary = publicSession(exited, { includeTombstone: true })
    expect(summary.tombstone).toEqual({
      reason: 'exit_marker',
      terminalAt: '2026-01-01T00:00:01.000Z',
      tailLines: 0,
      paneClosedAt: null,
    })
  })

  it('maps internal terminal sessions to the public exited status', () => {
    const terminal = session()
    terminal.status = 'terminal'
    terminal.tombstone = {
      reason: 'exit_marker',
      terminalAt: '2026-01-01T00:00:01.000Z',
      tail: [],
      paneClosedAt: null,
    }

    expect(publicSession(terminal).status).toBe('exited')
  })
})
