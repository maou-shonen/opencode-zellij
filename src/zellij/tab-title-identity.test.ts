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
  refreshBranch: (reason?: string) => Promise<void>
  handleEvent: (event: RawEvent) => Promise<void> | void
}

type IdentityModelConstructor = new (options: {
  projectName: string
  worktree: string
  readBranch: (worktree: string) => Promise<string>
}) => IdentityModel

function requireExport<T>(value: T | undefined, name: string): T {
  if (value === undefined)
    throw new Error(`${name} should be exported`)
  return value
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settleWithin<T>(promise: Promise<T>, ms = 200): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
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

describe('TabTitleIdentityModel', () => {
  it('reads the initial branch from the scoped worktree reader', async () => {
    const calls: string[] = []
    const model = createIdentityModel(async worktree => {
      calls.push(worktree)
      return ' main\n'
    })

    await model.ready

    expect(calls).toEqual(['/repo'])
    expect(model.projectName).toBe('my-project')
    expect(model.branchName).toBe('main')
  })

  it('ignores vcs.branch.updated payload and refreshes from the reader', async () => {
    let reads = 0
    const model = createIdentityModel(async () => {
      reads += 1
      return reads === 1 ? 'main\n' : 'feature/title\n'
    })

    await model.ready
    await model.handleEvent({ type: 'vcs.branch.updated', properties: { branch: 'wrong-branch' } })

    expect(model.branchName).toBe('feature/title')
    expect(reads).toBe(2)
  })

  it('drops stale async branch refresh results', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let reads = 0

    const model = createIdentityModel(async () => {
      reads += 1
      if (reads === 1)
        return 'main\n'
      if (reads === 2)
        return first.promise
      return second.promise
    })

    await model.ready

    const stale = model.refreshBranch('hint-a')
    const fresh = model.refreshBranch('hint-b')

    second.resolve('feature/fresh\n')
    await settleWithin(fresh)
    expect(model.branchName).toBe('feature/fresh')

    first.resolve('feature/stale\n')
    await settleWithin(stale)
    expect(model.branchName).toBe('feature/fresh')
  })

  it('keeps the previous branch when refresh fails', async () => {
    let reads = 0
    const model = createIdentityModel(async () => {
      reads += 1
      if (reads === 1)
        return 'main\n'
      throw new Error('git unavailable')
    })

    await model.ready

    await expect(model.refreshBranch('vcs.branch.updated')).resolves.toBeUndefined()
    expect(model.branchName).toBe('main')
  })
})
