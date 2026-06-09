import { afterEach, describe, expect, it } from 'bun:test'
import { isOpencodeTuiMode } from './runtime.js'

describe('isOpencodeTuiMode', () => {
  const originalRole = process.env.OPENCODE_PROCESS_ROLE

  afterEach(() => {
    if (originalRole === undefined)
      delete process.env.OPENCODE_PROCESS_ROLE
    else
      process.env.OPENCODE_PROCESS_ROLE = originalRole
  })

  it('returns false when OPENCODE_PROCESS_ROLE is unset', () => {
    delete process.env.OPENCODE_PROCESS_ROLE
    expect(isOpencodeTuiMode()).toBe(false)
  })

  it('returns false for headless opencode run (role=main)', () => {
    process.env.OPENCODE_PROCESS_ROLE = 'main'
    expect(isOpencodeTuiMode()).toBe(false)
  })

  it('returns true inside the TUI worker (role=worker)', () => {
    process.env.OPENCODE_PROCESS_ROLE = 'worker'
    expect(isOpencodeTuiMode()).toBe(true)
  })

  it('ignores unrelated role values', () => {
    process.env.OPENCODE_PROCESS_ROLE = 'desktop'
    expect(isOpencodeTuiMode()).toBe(false)
  })
})
