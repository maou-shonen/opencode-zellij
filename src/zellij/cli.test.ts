import { describe, expect, it } from 'bun:test'
import { buildNewPaneActionArgs, buildRenameTabActionArgs, parseCurrentPaneTabId, zellijActionArgs, zellijCommandArgs } from './cli.js'

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

  it('targets a stable tab id when renaming a tab', () => {
    expect(buildRenameTabActionArgs('🟢 my-project', { tabId: 7 })).toEqual([
      'action',
      'rename-tab',
      '--tab-id',
      '7',
      '🟢 my-project',
    ])
  })

  it('parses the current pane tab id from list-panes JSON', () => {
    const output = JSON.stringify([
      { id: 8, tab_id: 0, is_plugin: false },
      { id: 1, tab_id: 2, is_plugin: false },
      { id: 42, tab_id: 9, is_plugin: false },
    ])

    expect(parseCurrentPaneTabId(output, '42')).toBe(9)
    expect(parseCurrentPaneTabId(output, '8')).toBe(0)
  })

  it('parses nested and string pane/tab ids from list-panes JSON', () => {
    const output = JSON.stringify({ panes: [{ pane_id: '5', tabId: '3', is_plugin: false }] })

    expect(parseCurrentPaneTabId(output, '5')).toBe(3)
  })

  it('does not resolve plugin panes or malformed list-panes JSON', () => {
    expect(parseCurrentPaneTabId(JSON.stringify([
      { id: 42, tab_id: 9, is_plugin: true },
      { id: 42, tab_id: 10, is_plugin: false },
    ]), '42')).toBe(10)
    expect(parseCurrentPaneTabId(JSON.stringify([{ id: 42, tab_id: 9, is_plugin: true }]), '42')).toBeUndefined()
    expect(parseCurrentPaneTabId('not json', '42')).toBeUndefined()
    expect(parseCurrentPaneTabId(JSON.stringify([{ id: 7, tab_id: 1 }]), undefined)).toBeUndefined()
    expect(parseCurrentPaneTabId(JSON.stringify([{ id: 7, tab_id: 1 }]), 'terminal_7')).toBeUndefined()
  })
})
