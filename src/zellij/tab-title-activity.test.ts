import { describe, expect, it } from 'bun:test'
import * as tabTitle from './tab-title.js'

type RawEvent = {
  type: string
  properties?: Record<string, unknown> | null
}

type SessionRecord = {
  directory: string | undefined
  parentID: string | undefined
}

type ActivityModel = {
  status: 'idle' | 'running' | 'needs-input'
  handleEvent: (event: RawEvent) => Promise<void> | void
  getSession: (sessionID: string) => SessionRecord | undefined
  hasPendingInput: (sessionID: string, requestID: string) => boolean
}

type ActivityModelConstructor = new (options: {
  worktreeDirectory: string
}) => ActivityModel

function requireExport<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(`${name} should be exported`)
  return value
}

function createActivityModel(): ActivityModel {
  const ActivityModel = requireExport(
    (tabTitle as Record<string, unknown>).TabTitleActivityModel as ActivityModelConstructor | undefined,
    'TabTitleActivityModel',
  )

  return new ActivityModel({
    worktreeDirectory: '/repo',
  })
}

function sessionCreated(id: string, directory: string, parentID?: string): RawEvent {
  return {
    type: 'session.created',
    properties: {
      info: {
        id,
        directory,
        parentID,
      },
    },
  }
}

function sessionUpdated(id: string, directory: string, parentID?: string): RawEvent {
  return {
    type: 'session.updated',
    properties: {
      info: {
        id,
        directory,
        parentID,
      },
    },
  }
}

function sessionStatus(sessionID: string, type: 'idle' | 'busy' | 'retry'): RawEvent {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: type === 'retry'
        ? { type: 'retry', attempt: 1, message: 'retrying', next: 0 }
        : { type },
    },
  }
}

function questionAsked(sessionID: string, id: string): RawEvent {
  return {
    type: 'question.asked',
    properties: {
      sessionID,
      id,
    },
  }
}

function permissionAsked(sessionID: string, id: string): RawEvent {
  return {
    type: 'permission.asked',
    properties: {
      sessionID,
      id,
    },
  }
}

describe('TabTitleActivityModel', () => {
  it('stores scoped metadata from session.created and session.updated when the directory matches', () => {
    const activity = createActivityModel()

    activity.handleEvent(sessionCreated('s1', '/tmp/elsewhere', 'parent-1'))
    expect(activity.getSession('s1')).toBeUndefined()

    activity.handleEvent(sessionCreated('s1', '/repo', 'parent-1'))
    expect(activity.getSession('s1')).toEqual({ directory: '/repo', parentID: 'parent-1' })

    activity.handleEvent(sessionUpdated('s1', '/repo', 'parent-2'))
    expect(activity.getSession('s1')).toEqual({ directory: '/repo', parentID: 'parent-2' })
  })

  it('treats busy and retry as running for a scoped session', () => {
    for (const type of ['busy', 'retry'] as const) {
      const activity = createActivityModel()

      activity.handleEvent(sessionCreated('s1', '/repo'))
      activity.handleEvent(sessionStatus('s1', type))

      expect(activity.status).toBe('running')
    }
  })

  it('clears only the targeted scoped session on idle, session.idle, and session.error', () => {
    for (const event of [
      { type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } },
      { type: 'session.idle', properties: { sessionID: 'child' } },
      { type: 'session.error', properties: { sessionID: 'child' } },
    ] as const) {
      const activity = createActivityModel()

      activity.handleEvent(sessionCreated('parent', '/repo'))
      activity.handleEvent(sessionCreated('child', '/repo', 'parent'))
      activity.handleEvent(sessionStatus('parent', 'busy'))
      activity.handleEvent(sessionStatus('child', 'busy'))

      expect(activity.status).toBe('running')

      activity.handleEvent(event)
      expect(activity.status).toBe('running')
    }
  })

  it('keeps parent running when a child becomes idle', () => {
    const activity = createActivityModel()

    activity.handleEvent(sessionCreated('parent', '/repo'))
    activity.handleEvent(sessionCreated('child', '/repo', 'parent'))
    activity.handleEvent(sessionStatus('parent', 'busy'))
    activity.handleEvent(sessionStatus('child', 'busy'))

    expect(activity.status).toBe('running')

    activity.handleEvent({ type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } })

    expect(activity.status).toBe('running')
    expect(activity.getSession('child')).toEqual({ directory: '/repo', parentID: 'parent' })
  })

  it('leaves the visible status unchanged for unknown session and input events', () => {
    const activity = createActivityModel()

    activity.handleEvent(sessionCreated('known', '/repo'))
    activity.handleEvent(sessionStatus('known', 'busy'))
    expect(activity.status).toBe('running')

    for (const event of [
      { type: 'session.status', properties: { sessionID: 'ghost', status: { type: 'busy' } } },
      { type: 'session.idle', properties: { sessionID: 'ghost' } },
      questionAsked('ghost', 'q-ghost'),
      permissionAsked('ghost', 'p-ghost'),
    ] as const) {
      activity.handleEvent(event)
      expect(activity.status).toBe('running')
    }
  })

  it('enters needs-input for scoped question and permission requests', () => {
    for (const [event, requestID] of [
      [questionAsked('s1', 'q1'), 'q1'],
      [permissionAsked('s1', 'p1'), 'p1'],
    ] as const) {
      const activity = createActivityModel()

      activity.handleEvent(sessionCreated('s1', '/repo'))
      activity.handleEvent(sessionStatus('s1', 'busy'))
      activity.handleEvent(event)

      expect(activity.status).toBe('needs-input')
      expect(activity.hasPendingInput('s1', requestID)).toBe(true)
    }
  })

  it('keeps same request IDs isolated by session and clears them independently', () => {
    const activity = createActivityModel()

    activity.handleEvent(sessionCreated('s1', '/repo'))
    activity.handleEvent(sessionCreated('s2', '/repo'))
    activity.handleEvent(questionAsked('s1', 'q1'))
    activity.handleEvent(permissionAsked('s2', 'q1'))

    expect(activity.hasPendingInput('s1', 'q1')).toBe(true)
    expect(activity.hasPendingInput('s2', 'q1')).toBe(true)
    expect(activity.status).toBe('needs-input')

    activity.handleEvent({ type: 'question.replied', properties: { requestID: 'q1', sessionID: 's1' } })

    expect(activity.hasPendingInput('s1', 'q1')).toBe(false)
    expect(activity.hasPendingInput('s2', 'q1')).toBe(true)
    expect(activity.status).toBe('needs-input')
  })

  it('clears running state, pending input, and descendants when a parent session is deleted', () => {
    const activity = createActivityModel()

    activity.handleEvent(sessionCreated('parent', '/repo'))
    activity.handleEvent(sessionCreated('child', '/repo', 'parent'))
    activity.handleEvent(sessionStatus('parent', 'busy'))
    activity.handleEvent(sessionStatus('child', 'busy'))
    activity.handleEvent(questionAsked('child', 'q1'))

    expect(activity.status).toBe('needs-input')
    expect(activity.getSession('parent')?.directory).toBe('/repo')
    expect(activity.getSession('parent')?.parentID).toBeUndefined()
    expect(activity.getSession('child')).toEqual({ directory: '/repo', parentID: 'parent' })

    activity.handleEvent({ type: 'session.deleted', properties: { info: { id: 'parent', directory: '/repo', parentID: undefined } } })

    expect(activity.status).toBe('idle')
    expect(activity.getSession('parent')).toBeUndefined()
    expect(activity.getSession('child')).toBeUndefined()
    expect(activity.hasPendingInput('child', 'q1')).toBe(false)
  })
})
