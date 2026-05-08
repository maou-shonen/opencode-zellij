import type { PtySession } from '../pty/session.js'
import type { WatchdogRegistry } from './pane-watchdog.js'
import { describe, expect, it } from 'bun:test'
import { parseLinuxProcessStartTime, removeWatchdogPane, upsertWatchdogPane } from './pane-watchdog.js'

function registry(panes: WatchdogRegistry['panes'] = []): WatchdogRegistry {
  return {
    version: 1,
    instanceId: 'instance-1',
    ownerPid: 123,
    ownerStartTime: '999',
    zellijSessionName: 'dev',
    panes,
  }
}

function session(input: Partial<PtySession> & Pick<PtySession, 'id' | 'paneId'>): PtySession {
  return {
    id: input.id,
    openCodeSessionId: input.openCodeSessionId ?? 'opencode-session',
    paneId: input.paneId,
    title: input.title ?? 'pane title',
    command: input.command ?? 'bash',
    args: input.args ?? [],
    cwd: input.cwd ?? '/tmp/project',
    status: input.status ?? 'running',
    lineCount: input.lineCount ?? 0,
    createdAt: input.createdAt ?? '2026-05-08T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-05-08T00:00:00.000Z',
    allowAgentInput: input.allowAgentInput ?? true,
    humanInputOnly: input.humanInputOnly ?? false,
    exitCode: input.exitCode ?? null,
    exitedAt: input.exitedAt ?? null,
    exitCodeToken: input.exitCodeToken ?? null,
  }
}

describe('pane watchdog registry helpers', () => {
  it('extracts Linux process starttime from proc stat', () => {
    expect(parseLinuxProcessStartTime('12345 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 20')).toBe('777')
  })

  it('handles process names containing closing parentheses', () => {
    expect(parseLinuxProcessStartTime('12345 (strange)name)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 888 20')).toBe('888')
  })

  it('adds panes to the registry', () => {
    const updated = upsertWatchdogPane(registry(), session({ id: 'zpty_1', paneId: 'terminal_1', title: 'dev server' }))

    expect(updated.panes).toEqual([
      {
        sessionId: 'zpty_1',
        paneId: 'terminal_1',
        title: 'dev server',
        openCodeSessionId: 'opencode-session',
        createdAt: '2026-05-08T00:00:00.000Z',
      },
    ])
  })

  it('replaces panes with the same session id', () => {
    const original = registry([
      { sessionId: 'zpty_1', paneId: 'terminal_old', title: 'old', openCodeSessionId: null, createdAt: 'old' },
    ])

    const updated = upsertWatchdogPane(original, session({ id: 'zpty_1', paneId: 'terminal_new', title: 'new' }))

    expect(updated.panes.map(pane => pane.paneId)).toEqual(['terminal_new'])
  })

  it('replaces panes with the same pane id', () => {
    const original = registry([
      { sessionId: 'zpty_old', paneId: 'terminal_1', title: 'old', openCodeSessionId: null, createdAt: 'old' },
    ])

    const updated = upsertWatchdogPane(original, session({ id: 'zpty_new', paneId: 'terminal_1', title: 'new' }))

    expect(updated.panes.map(pane => pane.sessionId)).toEqual(['zpty_new'])
  })

  it('removes panes by session id', () => {
    const original = registry([
      { sessionId: 'zpty_1', paneId: 'terminal_1', title: 'one', openCodeSessionId: null, createdAt: 'one' },
      { sessionId: 'zpty_2', paneId: 'terminal_2', title: 'two', openCodeSessionId: null, createdAt: 'two' },
    ])

    const updated = removeWatchdogPane(original, 'zpty_1')

    expect(updated.panes.map(pane => pane.sessionId)).toEqual(['zpty_2'])
  })

  it('keeps registry unchanged when removing an unknown session id', () => {
    const original = registry([
      { sessionId: 'zpty_1', paneId: 'terminal_1', title: 'one', openCodeSessionId: null, createdAt: 'one' },
    ])

    expect(removeWatchdogPane(original, 'missing')).toEqual(original)
  })
})
