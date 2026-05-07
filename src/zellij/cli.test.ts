import { describe, expect, it } from 'bun:test'
import { buildNewPaneActionArgs, zellijActionArgs, zellijCommandArgs } from './cli.js'

describe('Zellij CLI helpers', () => {
  it('opens panes near the current pane to preserve focus', () => {
    expect(buildNewPaneActionArgs({ command: 'bash', title: 'demo', cwd: '/tmp' })).toEqual([
      'action',
      'new-pane',
      '--near-current-pane',
      '--name',
      'demo',
      '--cwd',
      '/tmp',
      '--',
      'bash',
      '-lc',
      'bash',
    ])
  })

  it('keeps floating panes near current pane as well', () => {
    expect(buildNewPaneActionArgs({ command: 'bash', floating: true })).toContain('--near-current-pane')
    expect(buildNewPaneActionArgs({ command: 'bash', floating: true })).toContain('--floating')
  })

  it('prefixes actions with explicit Zellij session when provided', () => {
    const previous = process.env.ZELLIJ_SESSION_NAME
    process.env.ZELLIJ_SESSION_NAME = 'demo-session'
    try {
      expect(zellijCommandArgs(zellijActionArgs('list-panes'))).toEqual(['--session', 'demo-session', 'action', 'list-panes'])
    }
    finally {
      if (previous === undefined)
        delete process.env.ZELLIJ_SESSION_NAME
      else process.env.ZELLIJ_SESSION_NAME = previous
    }
  })
})
