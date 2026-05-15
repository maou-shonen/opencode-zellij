import { describe, expect, it } from 'bun:test'
import * as tabTitle from './tab-title.js'

type RawEvent = {
  type: string
  properties?: Record<string, unknown> | null
}

type IdentityModel = {
  ready: Promise<void>
  projectName: string
  branchName: string | undefined
  handleEvent: (event: RawEvent) => Promise<void> | void
}

type ActivityModel = {
  status: 'idle' | 'running' | 'needs-input'
  handleEvent: (event: RawEvent) => Promise<void> | void
}

type ActorModel = {
  ready: Promise<void>
  title: string
  context: {
    projectName: string
    branchName: string | undefined
    status: 'idle' | 'running' | 'needs-input'
  }
  handleEvent: (event: RawEvent) => Promise<void> | void
}

type IdentityModelConstructor = new (options: {
  projectName: string
  worktree: string
  readBranch: (worktree: string) => Promise<string>
}) => IdentityModel

type ActivityModelConstructor = new (options: {
  worktreeDirectory: string
}) => ActivityModel

type ActorModelConstructor = new (options: {
  identity: IdentityModel
  activity: ActivityModel
}) => ActorModel

function requireExport<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(`${name} should be exported`)
  return value
}

function createIdentityModel(readBranch: (worktree: string) => Promise<string>): IdentityModel {
  const IdentityModel = requireExport(
    (tabTitle as Record<string, unknown>).TabTitleIdentityModel as IdentityModelConstructor | undefined,
    'TabTitleIdentityModel',
  )

  return new IdentityModel({
    projectName: 'my-project',
    worktree: '/repo',
    readBranch,
  })
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

function createActorModel(identity: IdentityModel, activity: ActivityModel): ActorModel {
  const ActorModel = requireExport(
    (tabTitle as Record<string, unknown>).TabTitleActor as ActorModelConstructor | undefined,
    'TabTitleActor',
  )

  return new ActorModel({
    identity,
    activity,
  })
}

describe('TabTitleActor', () => {
  it('composes identity and activity into the current title', async () => {
    const identity = createIdentityModel(async () => 'main\n')
    const activity = createActivityModel()
    const actor = createActorModel(identity, activity)

    await Promise.all([identity.ready, actor.ready])

    expect(actor.context).toEqual({
      projectName: 'my-project',
      branchName: 'main',
      status: 'idle',
    })
    expect(actor.title).toBe('🟢 my-project 🌱 main')
  })

  it('changes only the status emoji when a scoped session becomes busy', async () => {
    const identity = createIdentityModel(async () => 'main\n')
    const activity = createActivityModel()
    const actor = createActorModel(identity, activity)

    await Promise.all([identity.ready, actor.ready])

    await actor.handleEvent({ type: 'session.created', properties: { info: { id: 's1', directory: '/repo' } } })
    await actor.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })

    expect(actor.context).toEqual({
      projectName: 'my-project',
      branchName: 'main',
      status: 'running',
    })
    expect(actor.title).toBe('⚡ my-project 🌱 main')
  })

  it('changes only the branch segment when the branch refresh completes', async () => {
    let reads = 0
    const identity = createIdentityModel(async () => {
      reads += 1
      return reads === 1 ? 'main\n' : 'feature/tab-title\n'
    })
    const activity = createActivityModel()
    const actor = createActorModel(identity, activity)

    await Promise.all([identity.ready, actor.ready])
    await actor.handleEvent({ type: 'session.created', properties: { info: { id: 's1', directory: '/repo' } } })
    await actor.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
    await actor.handleEvent({ type: 'vcs.branch.updated', properties: { branch: 'wrong-branch' } })

    expect(actor.context).toEqual({
      projectName: 'my-project',
      branchName: 'feature/tab-title',
      status: 'running',
    })
    expect(actor.title).toBe('⚡ my-project 🌱 feature/tab-title')
  })

  it('ignores fake branch payload values in the rendered title', async () => {
    const identity = createIdentityModel(async () => 'feature/real-branch\n')
    const activity = createActivityModel()
    const actor = createActorModel(identity, activity)

    await Promise.all([identity.ready, actor.ready])

    await actor.handleEvent({ type: 'vcs.branch.updated', properties: { branch: 'wrong-branch' } })

    expect(actor.context.branchName).toBe('feature/real-branch')
    expect(actor.title).toBe('🟢 my-project 🌱 feature/real-branch')
  })

  it('ignores out-of-scope session events', async () => {
    const identity = createIdentityModel(async () => 'main\n')
    const activity = createActivityModel()
    const actor = createActorModel(identity, activity)

    await Promise.all([identity.ready, actor.ready])

    const initialTitle = actor.title

    await actor.handleEvent({
      type: 'session.created',
      properties: {
        info: {
          id: 'other',
          directory: '/different-worktree',
          parentID: undefined,
        },
      },
    })
    await actor.handleEvent({ type: 'session.status', properties: { sessionID: 'other', status: { type: 'busy' } } })
    await actor.handleEvent({ type: 'question.asked', properties: { sessionID: 'other', id: 'q-other' } })

    expect(actor.title).toBe(initialTitle)
    expect(actor.context).toEqual({
      projectName: 'my-project',
      branchName: 'main',
      status: 'idle',
    })
  })
})
