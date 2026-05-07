import { afterEach, describe, expect, it } from 'bun:test'
import { sessionManager } from '../pty/manager.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { zellijPtyWriteTool } from './write.js'

function cleanup(): void {
  for (const session of sessionManager.list()) {
    subscriberManager.forget(session.id)
    sessionManager.remove(session.id)
  }
}

describe('zellij_pty_write', () => {
  afterEach(cleanup)

  it('rejects human-only sessions without attempting a Zellij write', async () => {
    const session = sessionManager.create({
      openCodeSessionId: 'session_a',
      paneId: 'terminal_1',
      title: 'human',
      command: 'zellij_pty_request_sudo',
      cwd: process.cwd(),
      allowAgentInput: false,
      humanInputOnly: true,
    })

    const result = JSON.parse(toolResultText(await zellijPtyWriteTool.execute({ id: session.id, data: 'SHOULD_NOT_WRITE\n' }, testContext())))

    expect(result.next.retryable).toBe(false)
    expect(result.warnings.join('\n')).toContain('forbidden')
    expect(result.output).toEqual({ text: '', lines: [], lineCount: 0, returned: 0, truncated: false })
  })
})

function testContext(): Parameters<typeof zellijPtyWriteTool.execute>[1] {
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
