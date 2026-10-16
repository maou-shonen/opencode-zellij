import { describe, expect, it } from 'bun:test'
import { v2EventToActivityEvent } from './v2-event.js'
import { TabTitleActivityModel } from '../zellij/tab-title.js'
import { deletedSessionID } from '../zellij/tab-title-events.js'

function model(): TabTitleActivityModel {
  return new TabTitleActivityModel({ worktreeDirectory: '/repo' })
}

function apply(activity: TabTitleActivityModel, event: { type?: unknown, data?: unknown, location?: unknown }): void {
  const normalized = v2EventToActivityEvent(event)
  if (!normalized)
    throw new Error(`expected ${String(event.type)} to normalize`)
  activity.handleEvent(normalized)
}

describe('V2 event normalization', () => {
  it('marks a session in this worktree running from session.status', () => {
    const activity = model()
    apply(activity, {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/repo' } },
    })
    apply(activity, {
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'busy' } },
    })

    expect(activity.status).toBe('running')
  })

  it('ignores a busy session whose directory is outside this worktree', () => {
    const activity = model()
    apply(activity, {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/other' } },
    })
    apply(activity, {
      type: 'session.status',
      data: { sessionID: 's1', status: { type: 'busy' } },
    })

    expect(activity.status).toBe('idle')
  })

  it('treats session.execution.started as busy and a later success as idle', () => {
    const activity = model()
    apply(activity, {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/repo' } },
    })
    apply(activity, { type: 'session.execution.started', data: { sessionID: 's1' } })
    expect(activity.status).toBe('running')

    apply(activity, { type: 'session.execution.succeeded', data: { sessionID: 's1' } })
    expect(activity.status).toBe('idle')
  })

  it('scopes a forked child and a moved session by directory', () => {
    const activity = model()
    apply(activity, {
      type: 'session.created',
      data: { sessionID: 'parent', location: { directory: '/repo' } },
    })
    apply(activity, {
      type: 'session.forked',
      data: { sessionID: 'child', parentID: 'parent' },
      location: { directory: '/repo' },
    })
    apply(activity, {
      type: 'session.moved',
      data: { sessionID: 'moved', location: { directory: '/repo' } },
    })
    apply(activity, { type: 'session.execution.started', data: { sessionID: 'child' } })
    apply(activity, { type: 'session.execution.started', data: { sessionID: 'moved' } })

    expect(activity.getSession('child')?.parentID).toBe('parent')
    expect(activity.getSession('moved')?.directory).toBe('/repo')
    expect(activity.status).toBe('running')
  })

  it('asks for input on form.created and clears it on form.replied', () => {
    const activity = model()
    apply(activity, {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/repo' } },
    })
    apply(activity, {
      type: 'form.created',
      data: { form: { id: 'form_1', sessionID: 's1' } },
    })
    expect(activity.status).toBe('needs-input')
    expect(activity.hasPendingInput('s1', 'form_1')).toBe(true)

    apply(activity, {
      type: 'form.replied',
      data: { id: 'form_1', sessionID: 's1' },
    })
    expect(activity.hasPendingInput('s1', 'form_1')).toBe(false)
    expect(activity.status).toBe('running')

    apply(activity, { type: 'session.idle', data: { sessionID: 's1' } })
    expect(activity.status).toBe('idle')
  })

  it('asks for input on permission.asked and clears it on permission.replied', () => {
    const activity = model()
    apply(activity, {
      type: 'session.created',
      data: { sessionID: 's1', location: { directory: '/repo' } },
    })
    apply(activity, {
      type: 'permission.asked',
      data: { id: 'perm_1', sessionID: 's1', action: 'shell', resources: ['git push *'] },
    })
    expect(activity.status).toBe('needs-input')

    apply(activity, {
      type: 'permission.replied',
      data: { requestID: 'perm_1', sessionID: 's1', reply: 'once' },
    })
    expect(activity.hasPendingInput('s1', 'perm_1')).toBe(false)
    expect(activity.status).toBe('running')

    apply(activity, { type: 'session.idle', data: { sessionID: 's1' } })
    expect(activity.status).toBe('idle')
  })

  it('exposes a deleted session id on the shape the cleanup path reads', () => {
    const normalized = v2EventToActivityEvent({
      type: 'session.deleted',
      data: { sessionID: 's1' },
    })

    expect(normalized ? deletedSessionID(normalized) : undefined).toBe('s1')
  })

  it('drops token deltas and form events that are not tied to a session', () => {
    expect(v2EventToActivityEvent({
      type: 'session.text.delta',
      data: { sessionID: 's1', text: 'hi' },
    })).toBeUndefined()
    expect(v2EventToActivityEvent({
      type: 'form.created',
      data: { form: { id: 'form_1', sessionID: 'global' } },
    })).toBeUndefined()
    expect(v2EventToActivityEvent({ type: 'session.created', data: {} })).toBeUndefined()
  })
})
