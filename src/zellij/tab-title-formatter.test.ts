import { describe, expect, it } from 'bun:test'
import { defaultTabTitleEmojis, formatTabTitle } from './tab-title.js'

describe('formatTabTitle', () => {
  it('returns the status emoji only', () => {
    const base = {
      status: 'idle' as const,
      emojis: defaultTabTitleEmojis,
    }

    expect(formatTabTitle(base)).toBe('🟢')
    expect(formatTabTitle({ ...base, status: 'running' })).toBe('⚡')
    expect(formatTabTitle({ ...base, status: 'needs-input' })).toBe('💬')
  })

  it('uses custom emojis from the config', () => {
    const custom = {
      idle: 'I',
      running: 'R',
      needsInput: 'Q',
    }

    expect(formatTabTitle({ status: 'idle', emojis: custom })).toBe('I')
    expect(formatTabTitle({ status: 'running', emojis: custom })).toBe('R')
    expect(formatTabTitle({ status: 'needs-input', emojis: custom })).toBe('Q')
  })
})
