import { describe, expect, it } from 'bun:test'
import { defaultTabTitleEmojis, formatTabTitle } from './tab-title.js'

describe('formatTabTitle', () => {
  it('composes status, project, and branch deterministically', () => {
    const base = {
      status: 'idle' as const,
      projectName: 'my-project',
      branchName: 'main',
      emojis: defaultTabTitleEmojis,
    }

    expect(formatTabTitle(base)).toBe('🟢 my-project 🌱 main')
    expect(formatTabTitle({ ...base, status: 'running' })).toBe('⚡ my-project 🌱 main')
    expect(formatTabTitle({ ...base, status: 'needs-input' })).toBe('💬 my-project 🌱 main')
    expect(formatTabTitle({ ...base, branchName: 'feature/tab-title' })).toBe('🟢 my-project 🌱 feature/tab-title')
  })

  it('omits the branch segment without disturbing the rest of the title', () => {
    const base = {
      status: 'running' as const,
      projectName: 'my-project',
      branchName: undefined,
      emojis: defaultTabTitleEmojis,
    }

    expect(formatTabTitle(base)).toBe('⚡ my-project')
    expect(formatTabTitle({ ...base, branchName: '' })).toBe('⚡ my-project')
  })
})
