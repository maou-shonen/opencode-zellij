import { describe, expect, it } from 'bun:test'
import { zellijPtySpawnTool } from './spawn.js'

describe('zellij_pty_spawn', () => {
  it('rejects invalid output probe grep before creating a pane', async () => {
    await expect(zellijPtySpawnTool.execute({ command: 'bash', probe: { type: 'output', grep: '[' } }, testContext())).rejects.toThrow(/Invalid probe\.grep regex/)
  })

})

function testContext(): Parameters<typeof zellijPtySpawnTool.execute>[1] {
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
