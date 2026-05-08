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
    mockCli = {
      async renameTab(title: string) {
        calls.push(title)
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
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: failingCli })
      await expect(manager.renderImmediate()).resolves.toBeUndefined()
    })
  })

  it('retries a failed title sync on the next render', async () => {
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
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: retryingCli })

      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      await expect(manager.renderImmediate()).resolves.toBeUndefined()
      expect(calls).toEqual(['🟢 my-project', '🟢 my-project'])
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

  it('serializes in-flight title syncs and only applies the latest desired title next', async () => {
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
      }
      const manager = new TabTitleManager({ projectName: 'my-project', cli: blockingCli, debounceMs: 10 })

      const firstSync = manager.renderImmediate()
      manager.setBranch('main')
      manager.updateSessionStatus('s1', { type: 'busy' })
      await new Promise(r => setTimeout(r, 30))

      expect(calls).toEqual(['🟢 my-project'])
      resolveFirstRename?.()
      await firstSync
      expect(calls).toEqual(['🟢 my-project', '⚡ my-project 🌱 main'])
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
})
