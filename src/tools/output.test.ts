import { describe, expect, it } from 'bun:test'
import { validateGrep } from './output.js'

describe('tool output helpers', () => {
  it('accepts empty or valid grep regex', () => {
    expect(validateGrep(undefined)).toBeNull()
    expect(validateGrep('error|failed')).toBeNull()
  })

  it('returns an error message for invalid grep regex', () => {
    expect(validateGrep('[')).toContain('Invalid regular expression')
  })
})
