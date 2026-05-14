import { beforeEach, describe, expect, it } from 'bun:test'
import process from 'node:process'
import { sanitizeTitle, TabTitleManager, type TabTitleCli } from './tab-title.js'

async function withZellijEnv<T>(value: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const previous = process.env.ZELLIJ
  try {
    if (value === undefined)
      delete process.env.ZELLIJ
    else
      process.env.ZELLIJ = value

    return await Promise.resolve(run())
  }
  finally {
    if (previous === undefined)
      delete process.env.ZELLIJ
    else
      process.env.ZELLIJ = previous
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

describe('TabTitleManager', () => {
  let calls: string[]
  let mockCli: TabTitleCli

  beforeEach(() => {
    calls = []
    const currentCalls = calls
    mockCli = {
      async renameTab(title: string) {
        currentCalls.push(title)
      },
      async currentTabTitle() {
        return undefined
      },
    }
  })

  it('shows idle title when no sessions are known', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('shows running title when a session is busy', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'busy' })
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('shows running title when a session is retry', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'retry', attempt: 1, message: 'oops', next: 0 })
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('shows idle title after session becomes idle', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.markSessionIdle('s1')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('aggregates multiple sessions: busy wins', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'idle' })
      manager.updateSessionStatus('s2', { type: 'busy' })
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('shows needs-input title when a question or permission is pending', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.markNeedsInput('question_1', 's1')
      expect(manager.getCurrentTitle()).toBe('💬 my-project')
    })
  })

  it('prioritizes needs-input over running status', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.markNeedsInput('question_1', 's1')
      expect(manager.getCurrentTitle()).toBe('💬 my-project')
    })
  })

  it('returns to running or idle after pending input is cleared', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.markNeedsInput('question_1', 's1')
      manager.clearNeedsInput('question_1')
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
      manager.markSessionIdle('s1')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('clears pending input when its session is deleted', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.markNeedsInput('question_1', 's1')
      manager.removeSession('s1')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('removes session on deleted', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.removeSession('s1')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('parent busy + child busy + child idle => still running', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('parent', { type: 'busy' })
      manager.updateSessionStatus('child', { type: 'busy' })
      manager.markSessionIdle('child')
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('parent busy + child deleted => still running', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('parent', { type: 'busy' })
      manager.updateSessionStatus('child', { type: 'busy' })
      manager.removeSession('child')
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('parent idle + child busy => still running', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('parent', { type: 'idle' })
      manager.updateSessionStatus('child', { type: 'busy' })
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('parent busy + child busy + child idle + parent idle => idle', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('parent', { type: 'busy' })
      manager.updateSessionStatus('child', { type: 'busy' })
      manager.markSessionIdle('child')
      manager.markSessionIdle('parent')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('child idle must not clear parent running', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('parent', { type: 'busy' })
      manager.markSessionIdle('child')
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('needs-input overrides running/idle and clearing input returns to per-session running if present', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.markNeedsInput('q1', 's1')
      expect(manager.getCurrentTitle()).toBe('💬 my-project')
      manager.clearNeedsInput('q1')
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
      manager.markSessionIdle('s1')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('includes branch segment when branch is set', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.setBranch('main')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project 🌱 main')
    })
  })

  it('includes initial branch segment when provided', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', branchName: 'main', cli: mockCli })
      expect(manager.getCurrentTitle()).toBe('🟢 my-project 🌱 main')
    })
  })

  it('omits branch segment when branch is missing or empty', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.setBranch('')
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
      manager.setBranch(undefined)
      expect(manager.getCurrentTitle()).toBe('🟢 my-project')
    })
  })

  it('skips duplicate title updates', async () => {
    await withZellijEnv('1', async () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      await manager.renderImmediate()
      await manager.renderImmediate()
      expect(calls).toEqual(['🟢 my-project'])
    })
  })

  it('swallows rename errors', async () => {
    await withZellijEnv('1', async () => {
      const failingCli = {
        async renameTab(_title: string) {
          throw new Error('zellij not found')
        },
        async currentTabTitle() {
          return undefined
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: failingCli, retryInitialMs: 1 })
      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      manager.destroy()
    })
  })

  it('automatically retries a failed title sync without another render', async () => {
    await withZellijEnv('1', async () => {
      let shouldFail = true
      const retryingCli = {
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
      const manager = new TabTitleManager({ projectName: 'my-project', cli: retryingCli, retryInitialMs: 5 })

      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      await new Promise(r => setTimeout(r, 30))
      expect(calls).toEqual(['🟢 my-project', '🟢 my-project'])
      manager.destroy()
    })
  })

  it('retries the latest desired title after a failed sync', async () => {
    await withZellijEnv('1', async () => {
      let shouldFail = true
      const retryingCli = {
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
      const manager = new TabTitleManager({ projectName: 'my-project', cli: retryingCli, debounceMs: 1, retryInitialMs: 50 })

      await manager.renderImmediate()
      manager.setBranch('main')
      manager.updateSessionStatus('s1', { type: 'busy' })
      await new Promise(r => setTimeout(r, 30))
      expect(calls).toEqual(['🟢 my-project', '⚡ my-project 🌱 main'])
      manager.destroy()
    })
  })

  it('clears pending retry timers when destroyed', async () => {
    await withZellijEnv('1', async () => {
      const failingCli = {
        async renameTab(title: string) {
          calls.push(title)
          throw new Error('temporary zellij failure')
        },
        async currentTabTitle() {
          return undefined
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: failingCli, retryInitialMs: 5 })

      await manager.renderImmediate()
      manager.destroy()
      await new Promise(r => setTimeout(r, 30))
      expect(calls).toEqual(['🟢 my-project'])
    })
  })

  it('is a no-op when ZELLIJ is absent', async () => {
    await withZellijEnv(undefined, async () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      await manager.renderImmediate()
      expect(calls).toEqual([])
    })
  })

  it('uses custom emojis', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({
        projectName: 'my-project',
        branchName: 'main',
        cli: mockCli,
        emojis: { idle: 'I', running: 'R', needsInput: 'Q', branch: 'B' },
      })
      expect(manager.getCurrentTitle()).toBe('I my-project B main')
      manager.updateSessionStatus('s1', { type: 'busy' })
      expect(manager.getCurrentTitle()).toBe('R my-project B main')
      manager.markNeedsInput('question_1', 's1')
      expect(manager.getCurrentTitle()).toBe('Q my-project B main')
    })
  })

  it('debounces updates', async () => {
    await withZellijEnv('1', async () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli, debounceMs: 50 })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.updateSessionStatus('s2', { type: 'idle' })
      expect(calls).toEqual([])
      await new Promise(r => setTimeout(r, 120))
      expect(calls).toEqual(['⚡ my-project'])
    })
  })

  it('coalesces rapid state changes into one final title sync', async () => {
    await withZellijEnv('1', async () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli, debounceMs: 50 })
      manager.updateSessionStatus('s1', { type: 'busy' })
      manager.setBranch('main')
      manager.markSessionIdle('s1')

      expect(calls).toEqual([])
      await new Promise(r => setTimeout(r, 120))
      expect(calls).toEqual(['🟢 my-project 🌱 main'])
    })
  })

  it('uses the latest desired title after capturing the original title', async () => {
    await withZellijEnv('1', async () => {
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
      const manager = new TabTitleManager({ projectName: 'my-project', cli: blockingCli, debounceMs: 10 })

      const firstSync = manager.renderImmediate()
      manager.setBranch('main')
      manager.updateSessionStatus('s1', { type: 'busy' })
      await new Promise(r => setTimeout(r, 30))

      expect(calls).toEqual(['⚡ my-project 🌱 main'])
      resolveFirstRename?.()
      await firstSync
      expect(calls).toEqual(['⚡ my-project 🌱 main'])
    })
  })

  it('retries the latest desired title after an in-flight rename fails', async () => {
    await withZellijEnv('1', async () => {
      let rejectFirstRename: ((cause: Error) => void) | undefined
      const blockingCli: TabTitleCli = {
        async renameTab(title: string) {
          calls.push(title)
          if (calls.length === 1) {
            await new Promise<void>((_, reject) => {
              rejectFirstRename = reject
            })
          }
        },
        async currentTabTitle() {
          return undefined
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: blockingCli, debounceMs: 1, retryInitialMs: 5 })

      const firstSync = manager.renderImmediate()
      manager.setBranch('main')
      manager.updateSessionStatus('s1', { type: 'busy' })
      await new Promise(r => setTimeout(r, 10))
      expect(calls).toEqual(['⚡ my-project 🌱 main'])

      rejectFirstRename?.(new Error('temporary zellij failure'))
      await firstSync
      await new Promise(r => setTimeout(r, 30))

      expect(calls).toEqual(['⚡ my-project 🌱 main', '⚡ my-project 🌱 main'])
      manager.destroy()
    })
  })

  it('updates retry status even when type matches existing retry', async () => {
    await withZellijEnv('1', () => {
      const manager = new TabTitleManager({ projectName: 'my-project', cli: mockCli })
      manager.updateSessionStatus('s1', { type: 'retry', attempt: 1, message: 'a', next: 0 })
      manager.updateSessionStatus('s1', { type: 'retry', attempt: 2, message: 'b', next: 0 })
      expect(manager.getCurrentTitle()).toBe('⚡ my-project')
    })
  })

  it('saves original tab title on first render', async () => {
    const calls: string[] = []
    await withZellijEnv('1', async () => {
      const titleCapturingCli = {
        async renameTab(title: string) {
          calls.push(title)
        },
        async currentTabTitle() {
          return 'my-original-tab'
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: titleCapturingCli })
      await manager.renderImmediate()
      await manager.destroy()
      expect(calls).toEqual(['🟢 my-project', 'my-original-tab'])
    })
  })

  it('restores original tab title on destroy', async () => {
    let restoreTitle: string | undefined
    await withZellijEnv('1', async () => {
      const restoringCli = {
        async renameTab(title: string) {
          restoreTitle = title
        },
        async currentTabTitle() {
          return 'original-name'
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: restoringCli })
      await manager.renderImmediate()
      await manager.destroy()
      expect(restoreTitle).toBe('original-name')
    })
  })

  it('destroy is idempotent', async () => {
    const calls: string[] = []
    await withZellijEnv('1', async () => {
      const idempotentCli = {
        async renameTab(title: string) {
          calls.push(title)
        },
        async currentTabTitle() {
          return 'original-name'
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: idempotentCli })
      await manager.renderImmediate()
      await manager.destroy()
      await manager.destroy()
      expect(calls).toEqual(['🟢 my-project', 'original-name'])
    })
  })

  it('destroy is no-op when ZELLIJ is absent', async () => {
    let renameCount = 0
    await withZellijEnv(undefined, async () => {
      const cli = {
        async renameTab(_title: string) {
          renameCount++
        },
        async currentTabTitle() {
          return 'original-name'
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli })
      manager.destroy()
      expect(renameCount).toBe(0)
    })
  })

  it('captures original title before the first dynamic rename', async () => {
    await withZellijEnv('1', async () => {
      const calls: string[] = []
      let resolveCurrentTabTitle: ((title: string) => void) | undefined
      const slowCli = {
        async renameTab(title: string) {
          calls.push(title)
        },
        async currentTabTitle() {
          return new Promise<string>(resolve => {
            resolveCurrentTabTitle = resolve
          })
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: slowCli })
      const renderPromise = manager.renderImmediate()
      await new Promise(r => setTimeout(r, 10))
      expect(calls).toEqual([])
      resolveCurrentTabTitle!('slow-original')
      await renderPromise
      await manager.destroy()
      expect(calls).toEqual(['🟢 my-project', 'slow-original'])
    })
  })

  it('restores original title after an in-flight dynamic rename finishes', async () => {
    await withZellijEnv('1', async () => {
      const calls: string[] = []
      let resolveDynamicRename: (() => void) | undefined
      const blockingCli: TabTitleCli = {
        async renameTab(title: string) {
          calls.push(title)
          if (title === '🟢 my-project') {
            await new Promise<void>((resolve) => {
              resolveDynamicRename = resolve
            })
          }
        },
        async currentTabTitle() {
          return 'original-name'
        },
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: blockingCli })

      const renderPromise = manager.renderImmediate()
      await new Promise(r => setTimeout(r, 10))
      expect(calls).toEqual(['🟢 my-project'])

      const destroyPromise = manager.destroy()
      const secondDestroyPromise = manager.destroy()
      await new Promise(r => setTimeout(r, 10))
      expect(calls).toEqual(['🟢 my-project'])

      resolveDynamicRename?.()
      await renderPromise
      await destroyPromise
      await secondDestroyPromise
      expect(calls).toEqual(['🟢 my-project', 'original-name'])
    })
  })
})
