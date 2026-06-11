import type { PtySession } from '../pty/session.js'
import { afterEach, describe, expect, it } from 'bun:test'
import { sessionManager } from '../pty/manager.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { zellijPtyListTool } from './list.js'

type ListContext = Parameters<typeof zellijPtyListTool.execute>[1]

function cleanup(): void {
  for (const session of sessionManager.list()) {
    subscriberManager.forget(session.id)
    sessionManager.remove(session.id)
  }
}

function context(sessionID: string): ListContext {
  return {
    sessionID,
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

function createSession(openCodeSessionId: string, title: string): PtySession {
  return sessionManager.create({
    openCodeSessionId,
    paneId: `terminal_${Math.floor(Math.random() * 10_000)}`,
    title,
    command: 'bash',
    cwd: process.cwd(),
    allowAgentInput: true,
    humanInputOnly: false,
  })
}

describe('zellij_pty_list', () => {
  afterEach(cleanup)

  it('lists only sessions for the current OpenCode session', async () => {
    const current = createSession('session_a', 'current')
    createSession('session_b', 'other')

    const result = JSON.parse(toolResultText(await zellijPtyListTool.execute({}, context('session_a'))))

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].id).toBe(current.id)
    expect(result.sessions[0].subscriber).toEqual({ hasBuffer: false, active: false, lastExitedAt: null, terminal: false })
    expect(result.completedPaneIds).toEqual([])
    expect(result.completedPanes).toEqual([])
  })

  it('surfaces terminal sessions as completedPaneIds for the same OpenCode session', async () => {
    const active = createSession('session_a', 'active')
    const dead = createSession('session_a', 'dead')
    sessionManager.markExited(dead.id, 0)

    const result = JSON.parse(toolResultText(await zellijPtyListTool.execute({}, context('session_a'))))

    expect(result.sessions.map((s: Record<string, unknown>) => s.id).sort()).toEqual([active.id, dead.id].sort())
    expect(result.completedPaneIds).toEqual([dead.id])
    expect(result.completedPanes).toHaveLength(1)
    expect(result.completedPanes[0]).toMatchObject({
      id: dead.id,
      paneId: dead.paneId,
      status: 'exited',
      exitCode: 0,
      reason: 'exit_marker',
    })
  })
})

function toolResultText(result: unknown): string {
  if (typeof result === 'string')
    return result
  if (result && typeof result === 'object' && 'output' in result && typeof result.output === 'string')
    return result.output
  throw new Error('Unexpected tool result')
}
