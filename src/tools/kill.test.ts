import { describe, expect, it } from 'bun:test'
import { closeFailureMeansGone, zellijPtyKillTool } from './kill.js'

describe('zellij_pty_kill', () => {
  it('classifies close-pane errors that mean the pane is already gone', () => {
    expect(closeFailureMeansGone('pane not found')).toBe(true)
    expect(closeFailureMeansGone('unknown pane terminal_1')).toBe(true)
    expect(closeFailureMeansGone('permission denied')).toBe(false)
  })

  it('throws for unknown sessions', async () => {
    await expect(zellijPtyKillTool.execute({ id: 'zpty_missing' }, testContext())).rejects.toThrow(/Unknown zellij PTY session/)
  })
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
