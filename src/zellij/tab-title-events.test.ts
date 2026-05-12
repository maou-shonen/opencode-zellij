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
  it('routes busy status, deleted, and branch events while leaving idle reconciliation to snapshots', () => {
    const manager = new RecordingTabTitleManager()

    handleTabTitleEvent(manager, { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
    handleTabTitleEvent(manager, { type: 'session.idle', properties: { sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'session.error', properties: { sessionID: 's1' } })
    handleTabTitleEvent(manager, { type: 'vcs.branch.updated', properties: { branch: 'feature/title' } })
    handleTabTitleEvent(manager, { type: 'session.deleted', properties: { info: { id: 's1' } } })

    expect(manager.calls).toEqual([
      'status:s1:busy',
      'branch:feature/title',
      'remove:s1',
    ])
  })

  it('does not apply idle-like events optimistically', () => {
    expect(route({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } })).toEqual([])
    expect(route({ type: 'session.idle', properties: { sessionID: 's1' } })).toEqual([])
    expect(route({ type: 'session.error', properties: { sessionID: 's1' } })).toEqual([])
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
      'status:s1:busy',
      'clear-input:q1',
      'status:s1:busy',
      'needs-input:q2:s1',
      'status:s1:busy',
      'clear-input:q2',
      'status:s1:busy',
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
      'status:s1:busy',
      'clear-input:p1',
      'status:s1:busy',
      'needs-input:p2:s1',
      'status:s1:busy',
      'clear-input:p2',
      'status:s1:busy',
    ])
  })

  it('clears resolved permission.updated events instead of leaving stale pending input', () => {
    expect(route({ type: 'permission.updated', properties: { id: 'p1', sessionID: 's1', status: 'APPROVED' } })).toEqual(['clear-input:p1', 'status:s1:busy'])
    expect(route({ type: 'permission.updated', properties: { id: 'p2', sessionID: 's1', state: 'denied' } })).toEqual(['clear-input:p2', 'status:s1:busy'])
    expect(route({ type: 'permission.updated', properties: { id: 'p3', sessionID: 's1', status: 'pending' } })).toEqual(['needs-input:p3:s1', 'status:s1:busy'])
  })

  it('marks session busy alongside pending input for question.asked and permission.asked', () => {
    expect(route({ type: 'question.asked', properties: { id: 'q1', sessionID: 's1' } })).toEqual(['needs-input:q1:s1', 'status:s1:busy'])
    expect(route({ type: 'permission.asked', properties: { id: 'p1', sessionID: 's2' } })).toEqual(['needs-input:p1:s2', 'status:s2:busy'])
  })

  it('clears overlay and restores session to busy after question.replied or question.rejected', () => {
    expect(route({ type: 'question.replied', properties: { requestID: 'q1', sessionID: 's1' } })).toEqual(['clear-input:q1', 'status:s1:busy'])
    expect(route({ type: 'question.rejected', properties: { requestID: 'q2', sessionID: 's1' } })).toEqual(['clear-input:q2', 'status:s1:busy'])
  })

  it('clears overlay and restores session to busy after permission.replied', () => {
    expect(route({ type: 'permission.replied', properties: { requestID: 'p1', sessionID: 's1' } })).toEqual(['clear-input:p1', 'status:s1:busy'])
  })

  it('clears overlay and restores session to busy for resolved permission.updated', () => {
    expect(route({ type: 'permission.updated', properties: { id: 'p1', sessionID: 's1', status: 'APPROVED' } })).toEqual(['clear-input:p1', 'status:s1:busy'])
    expect(route({ type: 'permission.updated', properties: { id: 'p2', sessionID: 's1', state: 'denied' } })).toEqual(['clear-input:p2', 'status:s1:busy'])
  })

  it('marks pending and busy for pending/unresolved permission.updated', () => {
    expect(route({ type: 'permission.updated', properties: { id: 'p1', sessionID: 's1', status: 'pending' } })).toEqual(['needs-input:p1:s1', 'status:s1:busy'])
    expect(route({ type: 'permission.updated', properties: { id: 'p2', sessionID: 's2', state: 'unresolved' } })).toEqual(['needs-input:p2:s2', 'status:s2:busy'])
  })

  it('does not mark pending input without a session id', () => {
    expect(route({ type: 'question.asked', properties: { id: 'q1' } })).toEqual([])
    expect(route({ type: 'permission.updated', properties: { id: 'p1', status: 'pending' } })).toEqual([])
  })

  it('resolved permission.updated with no sessionID clears overlay but does not update busy', () => {
    expect(route({ type: 'permission.updated', properties: { id: 'p1', status: 'APPROVED' } })).toEqual(['clear-input:p1'])
    expect(route({ type: 'permission.updated', properties: { id: 'p2', state: 'denied' } })).toEqual(['clear-input:p2'])
  })

  it('question.replied with no sessionID clears overlay but does not update busy', () => {
    expect(route({ type: 'question.replied', properties: { requestID: 'q1' } })).toEqual(['clear-input:q1'])
    expect(route({ type: 'question.rejected', properties: { requestID: 'q2' } })).toEqual(['clear-input:q2'])
  })

  it('routes exact v2 question and permission payload ids', () => {
    const manager = new RecordingTabTitleManager()

    handleTabTitleEvent(manager, { type: 'question.asked', properties: { id: 'q1', sessionID: 's1', questions: [] } })
    handleTabTitleEvent(manager, { type: 'question.replied', properties: { requestID: 'q1', sessionID: 's1', answers: {} } })
    handleTabTitleEvent(manager, { type: 'permission.asked', properties: { id: 'p1', sessionID: 's1', permission: 'edit', patterns: [], metadata: {}, always: false } })
    handleTabTitleEvent(manager, { type: 'permission.replied', properties: { requestID: 'p1', sessionID: 's1', reply: 'allow' } })

    expect(manager.calls).toEqual([
      'needs-input:q1:s1',
      'status:s1:busy',
      'clear-input:q1',
      'status:s1:busy',
      'needs-input:p1:s1',
      'status:s1:busy',
      'clear-input:p1',
      'status:s1:busy',
    ])
  })

  it('routes disposal events to manager cleanup', () => {
    expect(route({ type: 'server.instance.disposed', properties: {} })).toEqual(['destroy'])
    expect(route({ type: 'global.disposed', properties: {} })).toEqual(['destroy'])
  })

  it('calls destroy on disposed events even when properties is null, a string, or missing/non-object', () => {
    // properties = null
    expect(route({ type: 'server.instance.disposed', properties: null })).toEqual(['destroy'])
    // properties = string
    expect(route({ type: 'global.disposed', properties: 'not-an-object' as unknown })).toEqual(['destroy'])
    // properties = number
    expect(route({ type: 'server.instance.disposed', properties: 42 as unknown })).toEqual(['destroy'])
    // properties missing (undefined) - handled via object without properties key
    const manager1 = new RecordingTabTitleManager()
    handleTabTitleEvent(manager1, { type: 'server.instance.disposed' } as OpenCodeEventLike)
    expect(manager1.calls).toEqual(['destroy'])
    // properties = undefined
    const manager2 = new RecordingTabTitleManager()
    handleTabTitleEvent(manager2, { type: 'global.disposed', properties: undefined })
    expect(manager2.calls).toEqual(['destroy'])
  })

  it('returns a promise from destroy on disposed events so caller can await', async () => {
    const manager = new RecordingTabTitleManager()
    let resolveOrder: string[] = []

    manager.destroy = () => {
      resolveOrder.push('destroy-start')
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          resolveOrder.push('destroy-end')
          resolve()
        }, 10)
      })
    }

    const result = handleTabTitleEvent(manager, { type: 'server.instance.disposed', properties: {} })
    expect(result).toBeInstanceOf(Promise)

    resolveOrder.push('await-start')
    await result
    resolveOrder.push('await-end')

    expect(resolveOrder).toEqual(['destroy-start', 'await-start', 'destroy-end', 'await-end'])
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
