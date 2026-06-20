import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import {
  defaultTabTitleEmojis,
  sanitizeTitle,
  TabTitleActivityModel,
  TabTitleActor,
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

async function applyEvent(actor: TabTitleActor, manager: TabTitleManager, event: Parameters<TabTitleActor['handleEvent']>[0]) {
  actor.handleEvent(event)
  manager.scheduleUpdate()
}

async function createHarness(options: TabTitleTestHarnessOptions = {}) {
  const calls: string[] = []
  const tabTitleCalls: (string | undefined)[] = []
  const explicitCurrentTab = 'currentTabTitle' in options
  const cli: TabTitleCli = options.cli ?? {
    async renameTab(title: string) {
      calls.push(title)
    },
    async currentTabTitle() {
      const title = explicitCurrentTab ? options.currentTabTitle : 'my-tab'
      tabTitleCalls.push(title)
      return title
    },
  }

  const activity = new TabTitleActivityModel({
    worktreeDirectory: '/repo',
  })
  const actor = new TabTitleActor({
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

  return {
    calls,
    tabTitleCalls,
    cli,
    activity,
    actor,
    manager,
  }
}

describe('TabTitleManager', () => {
  it('renderImmediate skips duplicate title updates', async () => {
    await withZellijEnv('1', async () => {
      const { manager, calls } = await createHarness()

      await manager.renderImmediate()
      await manager.renderImmediate()

      expect(calls).toEqual(['my-tab 🟢'])
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
          return 'my-tab'
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
          return 'my-tab'
        },
      }
      const { manager } = await createHarness({
        cli: retryingCli,
        retryInitialMs: 5,
      })

      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      await new Promise(r => setTimeout(r, 30))
      expect(calls).toEqual(['my-tab 🟢', 'my-tab 🟢'])
      await manager.destroy()
    })
  })

  it('coalesces rapid actor state changes into one final title sync', async () => {
    await withZellijEnv('1', async () => {
      const { actor, manager, calls } = await createHarness({
        debounceMs: 50,
      })

      await applyEvent(actor, manager, sessionCreated('s1'))
      await applyEvent(actor, manager, sessionStatus('s1', 'busy'))
      await applyEvent(actor, manager, sessionIdle('s1'))

      expect(calls).toEqual([])
      await new Promise(r => setTimeout(r, 120))
      expect(calls).toEqual(['my-tab 🟢'])
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
          return 'my-tab'
        },
      }
      const { actor, manager } = await createHarness({
        cli: blockingCli,
        debounceMs: 10,
      })

      const renderPromise = manager.renderImmediate()
      await new Promise(r => setTimeout(r, 10))
      expect(calls).toEqual(['my-tab 🟢'])
      await actor.handleEvent(sessionCreated('s1'))
      await actor.handleEvent(sessionStatus('s1', 'busy'))
      manager.scheduleUpdate()

      resolveFirstRename?.()
      await renderPromise

      expect(calls).toEqual(['my-tab 🟢', 'my-tab ⚡'])
      await manager.destroy()
    })
  })

  it('is a no-op when ZELLIJ is absent', async () => {
    await withZellijEnv(undefined, async () => {
      const { actor, manager, calls } = await createHarness({
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

  it('appends the status emoji when the current title has no trailing emoji', async () => {
    await withZellijEnv('1', async () => {
      const { manager, calls } = await createHarness({
        currentTabTitle: 'my-workspace',
      })

      await manager.renderImmediate()
      expect(calls).toEqual(['my-workspace 🟢'])
      await manager.destroy()
    })
  })

  it('replaces a trailing status emoji on status change', async () => {
    await withZellijEnv('1', async () => {
      const { actor, manager, calls } = await createHarness({
        currentTabTitle: 'my-workspace 🟢',
        debounceMs: 10,
      })

      await applyEvent(actor, manager, sessionCreated('s1'))
      await applyEvent(actor, manager, sessionStatus('s1', 'busy'))

      await new Promise(r => setTimeout(r, 30))
      expect(calls).toEqual(['my-workspace ⚡'])
      await manager.destroy()
    })
  })

  it('handles current title that is exactly a status emoji', async () => {
    await withZellijEnv('1', async () => {
      const { manager, calls } = await createHarness({
        currentTabTitle: '🟢',
      })

      await manager.renderImmediate()
      expect(calls).toEqual(['🟢'])
      await manager.destroy()
    })
  })

  it('skips sync when currentTabTitle returns undefined', async () => {
    await withZellijEnv('1', async () => {
      const { manager, calls } = await createHarness({
        currentTabTitle: undefined,
      })

      await manager.renderImmediate()
      expect(calls).toEqual([])
      await manager.destroy()
    })
  })

  it('appends emoji when the title contains emoji in the middle but not at the end', async () => {
    await withZellijEnv('1', async () => {
      const { manager, calls } = await createHarness({
        currentTabTitle: '🟢 my-project',
      })

      await manager.renderImmediate()
      // Emoji is at start, not at end, so append
      expect(calls).toEqual(['🟢 my-project 🟢'])
      await manager.destroy()
    })
  })

})
