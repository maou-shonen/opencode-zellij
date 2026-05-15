import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import {
  defaultTabTitleEmojis,
  sanitizeTitle,
  TabTitleActivityModel,
  TabTitleActor,
  TabTitleIdentityModel,
  TabTitleManager,
  type TabTitleCli,
} from './tab-title.js'

async function withZellijEnv<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.ZELLIJ
  const previousSessionName = process.env.ZELLIJ_SESSION_NAME
  try {
    if (value === undefined) {
      delete process.env.ZELLIJ
      delete process.env.ZELLIJ_SESSION_NAME
    }
    else {
      process.env.ZELLIJ = value
    }

    return await Promise.resolve(run())
  }
  finally {
    if (previous === undefined)
      delete process.env.ZELLIJ
    else
      process.env.ZELLIJ = previous

    if (previousSessionName === undefined)
      delete process.env.ZELLIJ_SESSION_NAME
    else
      process.env.ZELLIJ_SESSION_NAME = previousSessionName
  }
}

describe('sanitizeTitle', () => {
  it('removes control characters and newlines', () => {
    expect(sanitizeTitle('hello\x00world\n')).toBe('hello world')
  })

  it('collapses whitespace', () => {
    expect(sanitizeTitle('hello    world')).toBe('hello world')
  })

  it('trims', () => {
    expect(sanitizeTitle('  hello  ')).toBe('hello')
  })

  it('truncates long titles code-point-safely', () => {
    const long = 'a'.repeat(200)
    const result = sanitizeTitle(long)
    expect(result.length).toBeLessThanOrEqual(91)
    expect(result.endsWith('…')).toBe(true)
  })

  it('does not break emoji when truncating', () => {
    const title = '💬 ' + 'a'.repeat(95)
    const result = sanitizeTitle(title)
    expect(result.startsWith('💬')).toBe(true)
    expect(result.endsWith('…')).toBe(true)
  })
})

type TabTitleTestHarnessOptions = {
  cli?: TabTitleCli
  currentTabTitle?: string | undefined
  readBranch?: (worktree: string) => Promise<string>
  actorEmojis?: Partial<typeof defaultTabTitleEmojis>
  managerEmojis?: Partial<typeof defaultTabTitleEmojis>
  debounceMs?: number
  retryInitialMs?: number
  retryMaxMs?: number
}

function sessionCreated(sessionID: string, directory = '/repo', parentID?: string) {
  return {
    type: 'session.created',
    properties: {
      info: {
        id: sessionID,
        directory,
        parentID,
      },
    },
  }
}

function sessionStatus(sessionID: string, type: 'idle' | 'busy' | 'retry') {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: { type },
    },
  }
}

function sessionIdle(sessionID: string) {
  return {
    type: 'session.idle',
    properties: {
      sessionID,
    },
  }
}

function questionAsked(sessionID: string, id: string) {
  return {
    type: 'question.asked',
    properties: {
      sessionID,
      id,
    },
  }
}

function branchUpdated() {
  return {
    type: 'vcs.branch.updated',
  }
}

async function applyEvent(actor: TabTitleActor, manager: TabTitleManager, event: Parameters<TabTitleActor['handleEvent']>[0]) {
  await actor.handleEvent(event)
  manager.scheduleUpdate()
}

async function createHarness(options: TabTitleTestHarnessOptions = {}) {
  const calls: string[] = []
  const cli: TabTitleCli = options.cli ?? {
    async renameTab(title: string) {
      calls.push(title)
    },
    async currentTabTitle() {
      return options.currentTabTitle
    },
  }

  const identity = new TabTitleIdentityModel({
    projectName: 'my-project',
    worktree: '/repo',
    readBranch: options.readBranch ?? (async () => ''),
  })
  const activity = new TabTitleActivityModel({
    worktreeDirectory: '/repo',
  })
  const actor = new TabTitleActor({
    identity,
    activity,
    ...(options.actorEmojis ? { emojis: options.actorEmojis } : {}),
  })
  const manager = new TabTitleManager({
    actor,
    cli,
    ...(options.managerEmojis ? { emojis: options.managerEmojis } : {}),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.retryInitialMs !== undefined ? { retryInitialMs: options.retryInitialMs } : {}),
    ...(options.retryMaxMs !== undefined ? { retryMaxMs: options.retryMaxMs } : {}),
  })

  await Promise.all([identity.ready, actor.ready])

  return {
    calls,
    cli,
    identity,
    activity,
    actor,
    manager,
  }
}

describe('TabTitleManager', () => {
  it('getCurrentTitle renders idle title from actor context', async () => {
    await withZellijEnv('1', async () => {
      const { manager } = await createHarness({
        readBranch: async () => 'main\n',
      })

      expect(manager.getCurrentTitle()).toBe('🟢 my-project 🌱 main')
      await manager.destroy()
    })
  })

  it('manager emojis override actor/default rendering', async () => {
    await withZellijEnv('1', async () => {
      const { actor, manager } = await createHarness({
        readBranch: async () => 'main\n',
        actorEmojis: { idle: 'a', running: 'b', needsInput: 'c', branch: 'd' },
        managerEmojis: { idle: 'I', running: 'R', needsInput: 'Q', branch: 'B' },
      })

      await actor.handleEvent(sessionCreated('s1'))
      await actor.handleEvent(sessionStatus('s1', 'busy'))
      await actor.handleEvent(questionAsked('s1', 'q1'))

      expect(manager.getCurrentTitle()).toBe('Q my-project B main')
      await manager.destroy()
    })
  })

  it('renderImmediate skips duplicate title updates', async () => {
    await withZellijEnv('1', async () => {
      const { manager, calls } = await createHarness()

      await manager.renderImmediate()
      await manager.renderImmediate()

      expect(calls).toEqual(['🟢 my-project'])
      await manager.destroy()
    })
  })

  it('swallows rename errors', async () => {
    await withZellijEnv('1', async () => {
      const failingCli: TabTitleCli = {
        async renameTab() {
          throw new Error('zellij not found')
        },
        async currentTabTitle() {
          return undefined
        },
      }
      const { manager } = await createHarness({
        cli: failingCli,
        retryInitialMs: 1,
      })

      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      await manager.destroy()
    })
  })

  it('automatically retries a failed title sync without another render', async () => {
    await withZellijEnv('1', async () => {
      let shouldFail = true
      const calls: string[] = []
      const retryingCli: TabTitleCli = {
        async renameTab(title: string) {
          calls.push(title)
          if (shouldFail) {
            shouldFail = false
            throw new Error('temporary zellij failure')
          }
        },
        async currentTabTitle() {
          return undefined
        },
      }
      const { manager } = await createHarness({
        cli: retryingCli,
        retryInitialMs: 5,
      })

      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      await new Promise(r => setTimeout(r, 30))
      expect(calls).toEqual(['🟢 my-project', '🟢 my-project'])
      await manager.destroy()
    })
  })

  it('coalesces rapid actor state changes into one final title sync', async () => {
    await withZellijEnv('1', async () => {
      const { actor, manager, calls } = await createHarness({
        readBranch: async () => 'main\n',
        debounceMs: 50,
      })

      await applyEvent(actor, manager, sessionCreated('s1'))
      await applyEvent(actor, manager, sessionStatus('s1', 'busy'))
      await applyEvent(actor, manager, branchUpdated())
      await applyEvent(actor, manager, sessionIdle('s1'))

      expect(calls).toEqual([])
      await new Promise(r => setTimeout(r, 120))
      expect(calls).toEqual(['🟢 my-project 🌱 main'])
      await manager.destroy()
    })
  })

  it('uses the latest desired title while original title capture is in flight', async () => {
    await withZellijEnv('1', async () => {
      const calls: string[] = []
      let resolveCurrentTabTitle: (() => void) | undefined
      const blockingCli: TabTitleCli = {
        async renameTab(title: string) {
          calls.push(title)
        },
        async currentTabTitle() {
          return new Promise<string | undefined>((resolve) => {
            resolveCurrentTabTitle = () => resolve(undefined)
          })
        },
      }
      const { actor, manager } = await createHarness({
        cli: blockingCli,
        readBranch: async () => 'main\n',
      })

      const renderPromise = manager.renderImmediate()
      await actor.handleEvent(sessionCreated('s1'))
      await actor.handleEvent(sessionStatus('s1', 'busy'))
      await actor.handleEvent(branchUpdated())
      resolveCurrentTabTitle?.()
      await renderPromise

      expect(calls).toEqual(['⚡ my-project 🌱 main'])
      await manager.destroy()
    })
  })

  it('uses the latest desired title while a rename is in flight', async () => {
    await withZellijEnv('1', async () => {
      const calls: string[] = []
      let resolveFirstRename: (() => void) | undefined
      const blockingCli: TabTitleCli = {
        async renameTab(title: string) {
          calls.push(title)
          if (calls.length === 1) {
            await new Promise<void>((resolve) => {
              resolveFirstRename = resolve
            })
          }
        },
        async currentTabTitle() {
          return undefined
        },
      }
      const { actor, manager } = await createHarness({
        cli: blockingCli,
        readBranch: async () => 'main\n',
        debounceMs: 10,
      })

      const renderPromise = manager.renderImmediate()
      await new Promise(r => setTimeout(r, 10))
      expect(calls).toEqual(['🟢 my-project 🌱 main'])
      await actor.handleEvent(sessionCreated('s1'))
      await actor.handleEvent(sessionStatus('s1', 'busy'))
      await actor.handleEvent(branchUpdated())
      manager.scheduleUpdate()

      resolveFirstRename?.()
      await renderPromise

      expect(calls).toEqual(['🟢 my-project 🌱 main', '⚡ my-project 🌱 main'])
      await manager.destroy()
    })
  })

  it('is a no-op when ZELLIJ is absent', async () => {
    await withZellijEnv(undefined, async () => {
      const { actor, manager, calls } = await createHarness({
        readBranch: async () => 'main\n',
        debounceMs: 10,
      })

      await actor.handleEvent(sessionCreated('s1'))
      await actor.handleEvent(sessionStatus('s1', 'busy'))
      manager.scheduleUpdate()
      await manager.renderImmediate()

      expect(calls).toEqual([])
      await manager.destroy()
    })
  })

  it('saves and restores the original tab title and destroy is idempotent', async () => {
    await withZellijEnv('1', async () => {
      let currentTabTitleCalls = 0
      const calls: string[] = []
      const restoringCli: TabTitleCli = {
        async renameTab(title: string) {
          calls.push(title)
        },
        async currentTabTitle() {
          currentTabTitleCalls += 1
          return 'original-name'
        },
      }
      const { manager } = await createHarness({
        cli: restoringCli,
      })

      await manager.renderImmediate()
      await manager.destroy()
      await manager.destroy()

      expect(currentTabTitleCalls).toBe(1)
      expect(calls).toEqual(['🟢 my-project', 'original-name'])
    })
  })
})
