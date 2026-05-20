import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import { buildNewPaneActionArgs, buildRenameTabActionArgs, ZellijCli, zellijActionArgs, zellijCommandArgs } from './cli.js'

describe('Zellij CLI helpers', () => {
  async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(overrides)) {
      previous.set(key, process.env[key])
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }

    try {
      return await run()
    }
    finally {
      for (const [key, value] of previous) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    }
  }

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

  it('reads the active non-plugin tab title for session-only control', async () => {
    const calls: string[][] = []
    const cli = new ZellijCli(async (args) => {
      calls.push(args)
      return {
        stdout: JSON.stringify([
          { tab_id: 1, name: 'plugin-tab', active: true, is_plugin: true },
          { tab_id: 2, title: 'active-tab', active: true, is_plugin: false },
        ]),
        stderr: '',
      }
    })

    await withEnv({
      ZELLIJ: undefined,
      ZELLIJ_PANE_ID: undefined,
      ZELLIJ_SESSION_NAME: 'demo-session',
    }, async () => {
      await expect(cli.currentTabTitle()).resolves.toBe('active-tab')
    })

    expect(calls).toEqual([
      ['action', 'list-tabs', '--json'],
    ])
  })

  })
