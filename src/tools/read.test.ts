import { afterEach, describe, expect, it } from 'bun:test'
import { sessionManager } from '../pty/manager.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { zellijPtyReadTool } from './read.js'

function cleanup(): void {
  for (const session of sessionManager.list()) {
    subscriberManager.forget(session.id)
    sessionManager.remove(session.id)
  }
}

describe('zellij_pty_read', () => {
  afterEach(cleanup)

  it('returns a non-retryable response for invalid grep before starting a subscriber', async () => {
    const session = sessionManager.create({
      openCodeSessionId: 'session_a',
      paneId: 'terminal_1',
      title: 'read',
      command: 'bash',
      cwd: process.cwd(),
      allowAgentInput: true,
      humanInputOnly: false,
    })

    const result = JSON.parse(toolResultText(await zellijPtyReadTool.execute({ id: session.id, grep: '[' }, testContext())))

    expect(result.next.retryable).toBe(false)
    expect(result.next.reason).toContain('Invalid grep regex')
    expect(subscriberManager.has(session.id)).toBe(false)
  })
})

function testContext(): Parameters<typeof zellijPtyReadTool.execute>[1] {
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

function toolResultText(result: unknown): string {
  if (typeof result === 'string')
    return result
  if (result && typeof result === 'object' && 'output' in result && typeof result.output === 'string')
    return result.output
  throw new Error('Unexpected tool result')
}
