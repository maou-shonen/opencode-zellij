import { describe, expect, it } from 'bun:test'
import {
  normalizePaneId,
  parsePaneId,
  verifySpawnedTerminalPaneIdentity,
} from './pane.js'

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

  it('parses terminal_<n> pane ids from zellij stdout', () => {
    expect(parsePaneId('terminal_42\n')).toBe('terminal_42')
    expect(parsePaneId('terminal_42')).toBe('terminal_42')
  })

  it('parses bare numeric pane ids from zellij stdout', () => {
    expect(parsePaneId('42\n')).toBe('terminal_42')
    expect(parsePaneId('42')).toBe('terminal_42')
  })

  it('tolerates trailing whitespace and a leading prefix on a separate line', () => {
    // `m` flag: even if a future Zellij version adds a debug prefix on
    // an earlier line, we still recover the pane id from its own line.
    expect(parsePaneId('terminal_42  \n')).toBe('terminal_42')
    expect(parsePaneId('pid 1234\nterminal_2\n')).toBe('terminal_2')
  })

  it('refuses to pick the first number when stdout is ambiguous', () => {
    // Loose `\b\d+\b` would have returned `terminal_1234` here and
    // mapped the session to the wrong pane. The strict anchored
    // pattern is the whole point of this test.
    expect(() => parsePaneId('created pane 42\n')).toThrow(/Unable to parse/)
    expect(() => parsePaneId('pid 1234 terminal_2')).toThrow(/Unable to parse/)
    expect(() => parsePaneId('terminal_2 extra')).toThrow(/Unable to parse/)
    expect(() => parsePaneId('terminal_2 plugin_3')).toThrow(/Unable to parse/)
  })

  it('rejects stdout without pane ids', () => {
    expect(() => parsePaneId('created pane\n')).toThrow(/Unable to parse/)
  })

  it('rejects plugin_* pane ids (terminal-only)', () => {
    // `plugin_<id>` should not be accepted as a terminal pane id
    expect(() => parsePaneId('plugin_42')).toThrow(/Unable to parse/)
    expect(() => parsePaneId('plugin_1\n')).toThrow(/Unable to parse/)
  })
})

describe('verifySpawnedTerminalPaneIdentity', () => {
  it('accepts a new terminal pane id', () => {
    expect(verifySpawnedTerminalPaneIdentity({
      spawnOutput: 'terminal_42\n',
      currentPaneId: '1',
      paneIdsBeforeSpawn: new Set([1, 2, 3]),
    })).toEqual({
      normalizedPaneId: 'terminal_42',
      numericPaneId: 42,
    })
  })

  it('rejects output that resolves to the current pane id', () => {
    expect(() => verifySpawnedTerminalPaneIdentity({
      spawnOutput: '1\n',
      currentPaneId: 'terminal_1',
      paneIdsBeforeSpawn: new Set([2, 3]),
    })).toThrow(/Parsed pane id matches the current\/outer pane id/)
  })

  it('rejects output that resolves to a pane that already existed', () => {
    expect(() => verifySpawnedTerminalPaneIdentity({
      spawnOutput: 'terminal_7\n',
      currentPaneId: '1',
      paneIdsBeforeSpawn: new Set([2, 7]),
    })).toThrow(/already existed before spawn/)
  })

  it('surfaces raw output when parsing fails', () => {
    expect(() => verifySpawnedTerminalPaneIdentity({
      spawnOutput: 'plugin_9\n',
      currentPaneId: '1',
    })).toThrow(/raw new-pane output: "plugin_9\\n"/)
  })
})
