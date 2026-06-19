import { describe, expect, it } from 'bun:test'
import * as tabTitle from './tab-title.js'

type RawEvent = {
  type: string
  properties?: Record<string, unknown> | null
}

type ActivityModel = {
  status: 'idle' | 'running' | 'needs-input'
  handleEvent: (event: RawEvent) => void
}

type ActorModel = {
  title: string
  context: {
    status: 'idle' | 'running' | 'needs-input'
  }
  handleEvent: (event: RawEvent) => void
}

type ActivityModelConstructor = new (options: {
  worktreeDirectory: string
}) => ActivityModel

type ActorModelConstructor = new (options: {
  activity: ActivityModel
}) => ActorModel

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

function createActorModel(activity: ActivityModel): ActorModel {
  const ActorModel = requireExport(
    (tabTitle as Record<string, unknown>).TabTitleActor as ActorModelConstructor | undefined,
    'TabTitleActor',
  )

  return new ActorModel({
    activity,
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

function sessionStatus(sessionID: string, type: 'idle' | 'busy' | 'retry'): RawEvent {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: { type },
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

describe('TabTitleActor', () => {
  it('returns the idle emoji as the initial title', () => {
    const activity = createActivityModel()
    const actor = createActorModel(activity)

    expect(actor.context).toEqual({ status: 'idle' })
    expect(actor.title).toBe('🟢')
  })

  it('switches to the running emoji when a scoped session becomes busy', () => {
    const activity = createActivityModel()
    const actor = createActorModel(activity)

    actor.handleEvent(sessionCreated('s1', '/repo'))
    actor.handleEvent(sessionStatus('s1', 'busy'))

    expect(actor.context).toEqual({ status: 'running' })
    expect(actor.title).toBe('⚡')
  })

  it('switches to the needs-input emoji when a scoped question is asked', () => {
    const activity = createActivityModel()
    const actor = createActorModel(activity)

    actor.handleEvent(sessionCreated('s1', '/repo'))
    actor.handleEvent(sessionStatus('s1', 'busy'))
    actor.handleEvent(questionAsked('s1', 'q1'))

    expect(actor.context).toEqual({ status: 'needs-input' })
    expect(actor.title).toBe('💬')
  })

  it('ignores out-of-scope session and input events', () => {
    const activity = createActivityModel()
    const actor = createActorModel(activity)

    const initialTitle = actor.title

    actor.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'other',
          directory: '/different-worktree',
          parentID: undefined,
        },
      },
    })
    actor.handleEvent(sessionStatus('other', 'busy'))
    actor.handleEvent(questionAsked('other', 'q-other'))

    expect(actor.title).toBe(initialTitle)
    expect(actor.context).toEqual({ status: 'idle' })
  })
})
