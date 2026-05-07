import { describe, expect, it } from 'bun:test'
import ZellijPtyPlugin from './plugin.js'

describe('ZellijPtyPlugin', () => {
  it('exports an OpenCode plugin function', () => {
    expect(typeof ZellijPtyPlugin).toBe('function')
  })
})
