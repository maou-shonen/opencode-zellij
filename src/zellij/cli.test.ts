import { describe, expect, it } from 'bun:test'
import { buildNewPaneActionArgs, buildRenameTabActionArgs, zellijActionArgs, zellijCommandArgs } from './cli.js'

describe('Zellij CLI helpers', () => {
  function withZellijEnv<T>(value: string | undefined, run: () => T): T {
    const previous = process.env.ZELLIJ
    try {
      if (value === undefined)
        delete process.env.ZELLIJ
      else
        process.env.ZELLIJ = value

      return run()
    }
    finally {
      if (previous === undefined)
        delete process.env.ZELLIJ
      else
        process.env.ZELLIJ = previous
    }
  }

  it('opens panes near the current pane in attached Zellij sessions to preserve focus', () => {
    withZellijEnv('1', () => {
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
  })

  it('does not use near-current-pane for external session control', () => {
    withZellijEnv(undefined, () => {
      expect(buildNewPaneActionArgs({ command: 'bash', title: 'demo', cwd: '/tmp' })).toEqual([
        'action',
        'new-pane',
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
  })

  it('keeps floating panes near current pane as well', () => {
    withZellijEnv('1', () => {
      expect(buildNewPaneActionArgs({ command: 'bash', floating: true })).toContain('--near-current-pane')
      expect(buildNewPaneActionArgs({ command: 'bash', floating: true })).toContain('--floating')
    })
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

  it('builds rename-tab args with emoji and no extra quotes', () => {
    const title = '🟢 my-project 🌱 main'
    expect(buildRenameTabActionArgs(title)).toEqual(['action', 'rename-tab', title])
  })
})
