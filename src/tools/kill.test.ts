import { afterEach, describe, expect, it } from 'bun:test'
import { sessionManager } from '../pty/manager.js'
import { executeZellijPtyKill, zellijPtyKillTool } from './kill.js'

describe('zellij_pty_kill', () => {
  it('keeps the session when close-pane fails and the pane still exists', async () => {
    const session = sessionManager.create({
      openCodeSessionId: 'session_a',
      paneId: 'terminal_2',
      title: 'kill',
      command: 'bash',
      cwd: process.cwd(),
      allowAgentInput: true,
      humanInputOnly: false,
    })

    const result = await executeZellijPtyKill({ id: session.id }, {
      zellijCli: {
        sendCtrlC: async () => {},
        closePane: async () => {
          throw new Error('close failed')
        },
        paneExists: async () => true,
      },
    })

    expect(result.killed).toBe(false)
    expect(result.cleanedUp).toBe(false)
    expect(result.warnings.join('\n')).toContain('close-pane failed: close failed')
    expect(sessionManager.find(session.id)).toBeDefined()
  })

  it('keeps the session when pane verification is unavailable after close failure', async () => {
    const session = sessionManager.create({
      openCodeSessionId: 'session_a',
      paneId: 'terminal_3',
      title: 'kill',
      command: 'bash',
      cwd: process.cwd(),
      allowAgentInput: true,
      humanInputOnly: false,
    })

    const result = await executeZellijPtyKill({ id: session.id }, {
      zellijCli: {
        sendCtrlC: async () => {},
        closePane: async () => {
          throw new Error('close failed')
        },
        paneExists: async () => undefined,
      },
    })

    expect(result.killed).toBe(false)
    expect(result.cleanedUp).toBe(false)
    expect(result.warnings.join('\n')).toContain('close-pane failed: close failed')
    expect(sessionManager.find(session.id)).toBeDefined()
  })

  it('throws for unknown sessions', async () => {
    await expect(zellijPtyKillTool.execute({ id: 'zpty_missing' }, testContext())).rejects.toThrow(/Unknown zellij PTY session/)
  })
})

afterEach(() => {
  for (const session of sessionManager.list())
    sessionManager.remove(session.id)
})

function testContext(): Parameters<typeof zellijPtyKillTool.execute>[1] {
  return {
    sessionID: 'session_a',
    messageID: 'message',
    agent: 'test',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error('ask is not available in tests')
    },
  }
}
