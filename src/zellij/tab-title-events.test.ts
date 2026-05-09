import type { SessionStatus } from '@opencode-ai/sdk'
import { describe, expect, it } from 'bun:test'
import { deletedSessionID, getInitialBranch, handleTabTitleEvent, shouldReadInitialBranch, type OpenCodeEventLike, type TabTitleEventManager } from './tab-title-events.js'

class RecordingTabTitleManager implements TabTitleEventManager {
  readonly calls: string[] = []

  updateSessionStatus(sessionID: string, status: SessionStatus): void {
    this.calls.push(`status:${sessionID}:${status.type}`)
  }

  markSessionIdle(sessionID: string): void {
    this.calls.push(`idle:${sessionID}`)
  }

  removeSession(sessionID: string): void {
    this.calls.push(`remove:${sessionID}`)
  }

  markNeedsInput(id: string, sessionID: string): void {
    this.calls.push(`needs-input:${id}:${sessionID}`)
  }

  clearNeedsInput(id: string): void {
    this.calls.push(`clear-input:${id}`)
  }

  setBranch(branch: string | undefined): void {
    this.calls.push(`branch:${branch ?? ''}`)
  }

  destroy(): void {
    this.calls.push('destroy')
  }
}

function route(event: OpenCodeEventLike): string[] {
  const manager = new RecordingTabTitleManager()
  handleTabTitleEvent(manager, event)
  return manager.calls
}

describe('tab title event routing', () => {
  it('routes session status, idle, error, deleted, and branch events', () => {
    const manager = new RecordingTabTitleManager()

    handleTabTitleEvent(manager, { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
    handleTabTitleEvent(manager, { type: 'session.idle', properties: { sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'session.error', properties: { sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'vcs.branch.updated', properties: { branch: 'feature/title' } })
    handleTabTitleEvent(manager, { type: 'session.deleted', properties: { info: { id: 's1' } } })

    expect(manager.calls).toEqual([
      'status:s1:busy',
      'idle:s1',
      'idle:s1',
      'branch:feature/title',
      'remove:s1',
    ])
  })

  it('routes retry status', () => {
    expect(route({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'retry', attempt: 2, message: 'again', next: 10 } },
    })).toEqual(['status:s1:retry'])
  })

  it('routes question events to pending input state', () => {
    const manager = new RecordingTabTitleManager()

    handleTabTitleEvent(manager, { type: 'question.asked', properties: { id: 'q1', sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'question.replied', properties: { requestID: 'q1', sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'question.asked', properties: { id: 'q2', sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'question.rejected', properties: { requestID: 'q2', sessionID: 's1' } })

    expect(manager.calls).toEqual([
      'needs-input:q1:s1',
      'clear-input:q1',
      'needs-input:q2:s1',
      'clear-input:q2',
    ])
  })

  it('routes permission events to pending input state', () => {
    const manager = new RecordingTabTitleManager()

    handleTabTitleEvent(manager, { type: 'permission.asked', properties: { id: 'p1', sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'permission.replied', properties: { requestID: 'p1', sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'permission.updated', properties: { id: 'p2', sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'permission.replied', properties: { permissionID: 'p2', sessionID: 's1' } })

    expect(manager.calls).toEqual([
      'needs-input:p1:s1',
      'clear-input:p1',
      'needs-input:p2:s1',
      'clear-input:p2',
    ])
  })

  it('clears resolved permission.updated events instead of leaving stale pending input', () => {
    expect(route({ type: 'permission.updated', properties: { id: 'p1', sessionID: 's1', status: 'APPROVED' } })).toEqual(['clear-input:p1'])
    expect(route({ type: 'permission.updated', properties: { id: 'p2', sessionID: 's1', state: 'denied' } })).toEqual(['clear-input:p2'])
    expect(route({ type: 'permission.updated', properties: { id: 'p3', sessionID: 's1', status: 'pending' } })).toEqual(['needs-input:p3:s1'])
  })

  it('routes exact v2 question and permission payload ids', () => {
    const manager = new RecordingTabTitleManager()

    handleTabTitleEvent(manager, { type: 'question.asked', properties: { id: 'q1', sessionID: 's1', questions: [] } })
    handleTabTitleEvent(manager, { type: 'question.replied', properties: { requestID: 'q1', sessionID: 's1', answers: {} } })
    handleTabTitleEvent(manager, { type: 'permission.asked', properties: { id: 'p1', sessionID: 's1', permission: 'edit', patterns: [], metadata: {}, always: false } })
    handleTabTitleEvent(manager, { type: 'permission.replied', properties: { requestID: 'p1', sessionID: 's1', reply: 'allow' } })

    expect(manager.calls).toEqual([
      'needs-input:q1:s1',
      'clear-input:q1',
      'needs-input:p1:s1',
      'clear-input:p1',
    ])
  })

  it('routes disposal events to manager cleanup', () => {
    expect(route({ type: 'server.instance.disposed', properties: {} })).toEqual(['destroy'])
    expect(route({ type: 'global.disposed', properties: {} })).toEqual(['destroy'])
  })

  it('does not mark pending input without a session id', () => {
    expect(route({ type: 'question.asked', properties: { id: 'q1' } })).toEqual([])
    expect(route({ type: 'permission.updated', properties: { id: 'p1' } })).toEqual([])
  })

  it('ignores malformed events instead of throwing', () => {
    expect(route({ type: 'session.status', properties: { sessionID: 's1', status: 'busy' } })).toEqual([])
    expect(route({ type: 'question.asked', properties: null })).toEqual([])
  })

  it('extracts deleted session id from current and fallback payload shapes', () => {
    expect(deletedSessionID({ type: 'session.deleted', properties: { info: { id: 's1' } } })).toBe('s1')
    expect(deletedSessionID({ type: 'session.deleted', properties: { sessionID: 's2' } })).toBe('s2')
    expect(deletedSessionID({ type: 'session.deleted', properties: {} })).toBeUndefined()
  })

  it('reads initial git branch from a branch reader', async () => {
    await expect(getInitialBranch('/repo', async (worktree) => {
      expect(worktree).toBe('/repo')
      return ' main\n'
    })).resolves.toBe('main')
  })

  it('omits initial branch on empty output or branch reader failure', async () => {
    await expect(getInitialBranch('/repo', async () => '\n')).resolves.toBeUndefined()
    await expect(getInitialBranch('/repo', async () => {
      throw new Error('not a git repo')
    })).resolves.toBeUndefined()
  })

  it('only reads initial branch inside a real Zellij pane', () => {
    expect(shouldReadInitialBranch('0')).toBe(true)
    expect(shouldReadInitialBranch(undefined)).toBe(false)
  })
})
