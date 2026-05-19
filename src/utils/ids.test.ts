import { describe, expect, it } from 'bun:test'
import { createSessionId, normalizePaneId, parsePaneId } from './ids.js'

describe('pane id helpers', () => {
  it('normalizes numeric pane ids', () => {
    expect(normalizePaneId('7')).toBe('terminal_7')
  })

  it('keeps terminal pane ids', () => {
    expect(normalizePaneId('terminal_12')).toBe('terminal_12')
  })

  it('rejects invalid pane ids', () => {
    expect(() => normalizePaneId('pane_a')).toThrow(/Invalid Zellij terminal pane id/)
  })

  it('parses pane ids from zellij stdout', () => {
    expect(parsePaneId('terminal_42\n')).toBe('terminal_42')
    expect(parsePaneId('created pane 42\n')).toBe('terminal_42')
  })

  it('rejects stdout without pane ids', () => {
    expect(() => parsePaneId('created pane\n')).toThrow(/Unable to parse/)
  })

  it('rejects plugin_* pane ids (terminal-only)', () => {
    // `plugin_<id>` should not be accepted as a terminal pane id
    expect(() => parsePaneId('plugin_42')).toThrow(/Unable to parse/)
    expect(() => parsePaneId('plugin_1\n')).toThrow(/Unable to parse/)
  })

  it('creates short zellij pty session ids', () => {
    expect(createSessionId()).toMatch(/^zpty_[a-f0-9]{10}$/)
  })
})
