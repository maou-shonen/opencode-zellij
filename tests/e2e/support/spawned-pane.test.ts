import { describe, expect, it } from 'bun:test'
import { verifySpawnedTerminalPaneIdentity } from './spawned-pane.js'

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
      spawnOutput: 'created pane 1\n',
      currentPaneId: 'terminal_1',
      paneIdsBeforeSpawn: new Set([1]),
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
