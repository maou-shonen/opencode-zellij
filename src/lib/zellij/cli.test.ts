import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import {
  buildNewPaneActionArgs,
  buildRenameTabActionArgs,
  createZellijClient,
  type ZellijRunOptions,
  type ZellijRunner,
  zellijActionArgs,
  zellijCommandArgs,
} from './cli.js'

describe('Zellij CLI arg builders', () => {
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
})

describe('createZellijClient', () => {
  it('passes the runner through to every zellij call', async () => {
    const calls: Array<{ args: string[], options: ZellijRunOptions | undefined }> = []
    const runner: ZellijRunner = {
      run: async (actionArgs, options) => {
        calls.push({ args: actionArgs, options })
        return { stdout: '', stderr: '' }
      },
    }

    const client = createZellijClient({ runner })

    await client.writeChars('terminal_3', 'hello')
    await client.sendCtrlC('terminal_3')
    await client.closePane('terminal_3')
    await client.focusPane('terminal_3')
    await client.renameTabById(7, 'demo')

    expect(calls.map(c => c.args)).toEqual([
      ['action', 'write-chars', '--pane-id', 'terminal_3', 'hello'],
      ['action', 'send-keys', '--pane-id', 'terminal_3', 'Ctrl c'],
      ['action', 'close-pane', '--pane-id', 'terminal_3'],
      ['action', 'focus-pane-id', 'terminal_3'],
      ['action', 'rename-tab', '--tab-id', '7', 'demo'],
    ])
  })
})
