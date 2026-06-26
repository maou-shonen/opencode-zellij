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

  it('omits --near-current-pane for floating panes so they use their own positioning', () => {
    withZellijEnv('1', () => {
      const args = buildNewPaneActionArgs({ command: 'bash', floating: true })
      expect(args).not.toContain('--near-current-pane')
      expect(args).toContain('--floating')
    })
  })

  it('passes through floating width, height, and pinned flags', () => {
    expect(buildNewPaneActionArgs({
      command: 'bash',
      floating: true,
      floatingWidth: '80%',
      floatingHeight: '60%',
      floatingPinned: true,
    })).toEqual(expect.arrayContaining([
      '--floating',
      '--width', '80%',
      '--height', '60%',
      '--pinned', 'true',
    ]))
  })

  it('omits floating size flags when not provided', () => {
    const args = buildNewPaneActionArgs({ command: 'bash', floating: true })
    expect(args).not.toContain('--width')
    expect(args).not.toContain('--height')
    // `--pinned` is only added when explicitly enabled; never as a bare flag.
    expect(args.some(arg => arg.startsWith('--pinned'))).toBe(false)
  })

  it('passes --close-on-exit when requested so the pane closes after the command finishes', () => {
    const args = buildNewPaneActionArgs({ command: 'bash', closeOnExit: true })
    expect(args).toContain('--close-on-exit')
  })

  it('omits --close-on-exit by default so spawned panes survive the command', () => {
    const args = buildNewPaneActionArgs({ command: 'bash' })
    expect(args).not.toContain('--close-on-exit')
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
