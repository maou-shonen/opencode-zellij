import { afterEach, describe, expect, it } from 'bun:test'
import { sessionManager } from '../pty/manager.js'
import { zellijCli } from '../zellij/cli.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { executeZellijPtyRead, zellijPtyReadTool } from './read.js'
import { type PaneExistsFn } from './pane-cleanup.js'

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

  it('keeps the session when close failure cannot be verified as gone', async () => {
    const { session, deps } = createCompletedReadFixture('zpty_terminal_exists', 'terminal_3', {
      paneExists: async () => true,
      closeSessionPane: async () => {
        throw new Error('close failed')
      },
    })

    const result = await executeZellijPtyRead({ id: session.id, cleanupExitedPaneOnRead: true }, deps)

    expect(result.cleanup).toEqual({ requested: true, performed: false, alreadyClosed: false, warning: expect.stringContaining('Completed pane cleanup failed: close failed') })
    expect(session.tombstone?.paneClosedAt).toBeNull()
  })

  it('keeps the session when pane verification throws after close failure', async () => {
    const { session, deps, closeCalls: closed, markCalls: marked } = createCompletedReadFixture('zpty_terminal_verify_throw', 'terminal_4', {
      paneExists: async () => {
        throw new Error('list-panes unavailable')
      },
      closeSessionPane: async () => {
        throw new Error('close failed')
      },
    })

    const result = await executeZellijPtyRead({ id: session.id, cleanupExitedPaneOnRead: true }, deps)

    expect(closed()).toBe(1)
    expect(marked()).toBe(0)
    expect(result.cleanup).toEqual({ requested: true, performed: false, alreadyClosed: false, warning: expect.stringContaining('Completed pane cleanup failed: close failed') })
    expect(session.tombstone?.paneClosedAt).toBeNull()
  })

  it('preserves zellijCli.paneExists binding during cleanup verification', async () => {
    const originalPaneExists = zellijCli.paneExists
    const paneExistsCalls: string[] = []
    ;(zellijCli as any).paneExistsCalls = paneExistsCalls
    zellijCli.paneExists = async function (this: { paneExistsCalls: string[] }, paneId: string): Promise<boolean> {
      this.paneExistsCalls.push(paneId)
      return false
    }

    try {
      const { session, deps, closeCalls: closed, markCalls: marked } = createCompletedReadFixture('zpty_terminal_binding', 'terminal_5', {
        closeSessionPane: async () => {
          throw new Error('close failed')
        },
      })

      const result = await executeZellijPtyRead({ id: session.id, cleanupExitedPaneOnRead: true }, {
        ...deps,
        paneExists: undefined,
      })

      expect(closed()).toBe(1)
      expect(marked()).toBe(1)
      expect(paneExistsCalls).toEqual(['terminal_5'])
      expect(result.cleanup).toEqual({ requested: true, performed: true, alreadyClosed: true })
      expect(session.tombstone?.paneClosedAt).toBe('2026-01-01T00:00:10.000Z')
    }
    finally {
      zellijCli.paneExists = originalPaneExists
      delete (zellijCli as any).paneExistsCalls
    }
  })
})

function createCompletedReadFixture(
  id: string,
  paneId: string,
  overrides: {
    paneExists?: PaneExistsFn
    closeSessionPane?: () => Promise<void>
  } = {},
): {
    session: any
    deps: any
    closeCalls: () => number
    markCalls: () => number
  } {
  const session: any = {
    id,
    openCodeSessionId: 'session_a',
    paneId,
    title: 'read',
    command: 'bash',
    args: [],
    cwd: process.cwd(),
    status: 'terminal' as const,
    lineCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    allowAgentInput: true,
    humanInputOnly: false,
    exitCode: 0,
    exitedAt: '2026-01-01T00:00:00.000Z',
    exitCodeToken: null,
    tombstone: {
      reason: 'exit_marker' as const,
      terminalAt: '2026-01-01T00:00:00.000Z',
      tail: ['one', 'two', 'three'],
      paneClosedAt: null,
      notificationSentAt: null,
    },
  }

  let closeCalls = 0
  let markCalls = 0
  return {
    session,
    deps: {
      sessionManager: {
        get: () => session,
        updateStatus() {
        },
        markTerminalPaneClosed() {
          markCalls += 1
          session.tombstone!.paneClosedAt = '2026-01-01T00:00:10.000Z'
          return session
        },
      },
      subscriberManager: {
        status: () => ({ hasBuffer: true, active: false, lastExitedAt: '2026-01-01T00:00:00.000Z', terminal: true }),
        start: async () => {},
        stderr: () => [],
        closeSessionPane: async () => {
          closeCalls += 1
          if (overrides.closeSessionPane)
            await overrides.closeSessionPane()
        },
      },
      paneExists: overrides.paneExists ?? (async () => false),
      readOutputSnapshot: () => ({ text: 'final', lines: ['final'], lineCount: 3, returned: 1, truncated: false }),
    },
    closeCalls: () => closeCalls,
    markCalls: () => markCalls,
  }
}

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
