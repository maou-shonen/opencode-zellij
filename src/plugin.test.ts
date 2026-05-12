import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ZellijPtyPlugin, { createZellijPtyPlugin, showUpdateToast, startAutoUpdateCheck } from './plugin.js'
import type { UpdateResult } from './auto-update.js'

const ptyToolNames = [
  'zellij_pty_kill',
  'zellij_pty_list',
  'zellij_pty_read',
  'zellij_pty_request_sudo',
  'zellij_pty_spawn',
  'zellij_pty_write',
]

const ptyToolNamesWithoutSudo = ptyToolNames.filter(name => name !== 'zellij_pty_request_sudo')

describe('ZellijPtyPlugin', () => {
  let tempRoot = ''
  let originalXdgConfigHome: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-plugin-'))
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(tempRoot, 'xdg')
  })

  afterEach(async () => {
    if (originalXdgConfigHome === undefined)
      delete process.env.XDG_CONFIG_HOME
    else
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    await rm(tempRoot, { force: true, recursive: true })
  })

  function pluginInput(directory: string, input: Record<string, unknown> = {}): Parameters<typeof ZellijPtyPlugin>[0] {
    return { directory, ...input } as Parameters<typeof ZellijPtyPlugin>[0]
  }

  async function writeProjectConfig(directory: string, content: string): Promise<void> {
    const configDir = join(directory, '.opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode-zellij.config.jsonc'), content)
  }

  it('exports an OpenCode plugin function', () => {
    expect(typeof ZellijPtyPlugin).toBe('function')
  })

  it('registers pty tools by default', async () => {
    const plugin = await ZellijPtyPlugin(pluginInput(join(tempRoot, 'project')), {})

    expect(Object.keys(plugin.tool ?? {}).sort()).toEqual(ptyToolNames)
  })

  it('does not register pty tools when pty is disabled', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "pty": { "enabled": false } }')
    const plugin = await ZellijPtyPlugin(pluginInput(project), {})

    expect(plugin.tool).toEqual({})
  })

  it('hides sudo tool when sudoPane is hide', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "pty": { "sudoPane": "hide" } }')
    const plugin = await ZellijPtyPlugin(pluginInput(project), {})

    expect(Object.keys(plugin.tool ?? {}).sort()).toEqual(ptyToolNamesWithoutSudo)
  })

  it('starts auto-update during plugin initialization without waiting for events', async () => {
    const project = join(tempRoot, 'project')
    const calls: string[] = []
    const pluginFactory = createZellijPtyPlugin({
      importMetaUrl: 'file:///plugin/dist/index.mjs',
      startAutoUpdateCheck: (_client, importMetaUrl) => {
        calls.push(importMetaUrl)
      },
    })

    await pluginFactory(pluginInput(project), {})

    expect(calls).toEqual(['file:///plugin/dist/index.mjs'])
  })

  it('does not start auto-update when disabled by config', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "autoUpdate": false }')
    const calls: string[] = []
    const pluginFactory = createZellijPtyPlugin({
      startAutoUpdateCheck: () => {
        calls.push('called')
      },
    })

    await pluginFactory(pluginInput(project), {})

    expect(calls).toEqual([])
  })

  it('keeps sudo tool visible when sudoPane is deny', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "pty": { "sudoPane": "deny" } }')
    const plugin = await ZellijPtyPlugin(pluginInput(project), {})

    expect(Object.keys(plugin.tool ?? {})).toContain('zellij_pty_request_sudo')
  })

  it('calls client.session.status at initialization with workspace directory', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const callDirectory: string[] = []
    const pluginFactory = createZellijPtyPlugin({})
    const plugin = await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async (opts: { query: { directory: string } }) => {
            callDirectory.push(opts.query.directory)
            return { data: {} }
          },
        },
      },
    }), {}) as { event?: (input: { event: unknown }) => Promise<void> }
    await plugin.event?.({ event: { type: 'vcs.branch.updated', properties: { branch: 'main' } } })
    // Initial snapshot is awaited before the first render, so the directory
    // should already be captured without depending on event refresh timing.
    expect(callDirectory.some(d => d === project)).toBe(true)
  })

  it('does not throw when client.session.status is missing', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const pluginFactory = createZellijPtyPlugin({})
    // Should not throw even though client.session is absent
    await pluginFactory(pluginInput(project, { client: {} }), {})
  })

  it('does not throw when client.session.status throws', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const pluginFactory = createZellijPtyPlugin({})
    await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async () => {
            throw new Error('network error')
          },
        },
      },
    }), {})
    // Should not throw — errors are swallowed
  })

  it('does not throw when client.session.status returns raw array', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const pluginFactory = createZellijPtyPlugin({})
    // Should handle plain array response (not { data: [...] } envelope)
    await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async () => [
            { sessionID: 's1', status: { type: 'busy' } },
          ],
        },
      },
    }), {})
  })

  it('schedules snapshot refresh on session status events', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const callDirectory: string[] = []
    const pluginFactory = createZellijPtyPlugin({})
    const plugin = await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async (opts: { query: { directory: string } }) => {
            callDirectory.push(opts.query.directory)
            return { data: {} }
          },
        },
      },
    }), {}) as { event?: (input: { event: unknown }) => Promise<void> }
    // Fire multiple events that should trigger snapshot refresh
    await plugin.event?.({ event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } } })
    await plugin.event?.({ event: { type: 'session.idle', properties: { sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'session.error', properties: { sessionID: 's1' } } })
    const initialCalls = callDirectory.length
    await new Promise(resolve => setTimeout(resolve, 1_100))
    // Debounce coalesces the three events into one snapshot refresh.
    expect(callDirectory.length).toBe(initialCalls + 1)
    expect(callDirectory.at(-1)).toBe(project)
  })

  it('does not fire pending snapshot refresh after disposed event', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const callDirectory: string[] = []
    const pluginFactory = createZellijPtyPlugin({})
    const plugin = await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async (opts: { query: { directory: string } }) => {
            callDirectory.push(opts.query.directory)
            return { data: {} }
          },
        },
      },
    }), {}) as { event?: (input: { event: unknown }) => Promise<void> }

    const callsAfterInit = callDirectory.length

    await plugin.event?.({ event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } } })
    await plugin.event?.({ event: { type: 'server.instance.disposed', properties: {} } })

    // Wait long enough for any non-disposed debounce to have fired (1s debounce + buffer)
    await new Promise(resolve => setTimeout(resolve, 1_200))

    // No additional session.status calls should occur because the disposed event cancels the timer.
    expect(callDirectory.length).toBe(callsAfterInit)
  })
})

describe('showUpdateToast', () => {
  function mockClient(): { calls: unknown[], client: Parameters<typeof showUpdateToast>[0] } {
    const calls: unknown[] = []
    return {
      calls,
      client: {
        tui: {
          showToast: (options: unknown) => {
            calls.push(options)
            return Promise.resolve()
          },
        },
      },
    }
  }

  it('shows success toast when update was installed', () => {
    const { calls, client } = mockClient()
    const result: UpdateResult = { type: 'updated', fromVersion: '0.0.1', toVersion: '0.0.2' }

    showUpdateToast(client, result)

    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({
      body: {
        title: 'opencode-zellij updated',
        message: 'Updated to 0.0.2. Restart OpenCode to apply the changes.',
        variant: 'success',
        duration: 10_000,
      },
    })
  })

  it('shows error toast when update failed', () => {
    const { calls, client } = mockClient()
    const result: UpdateResult = { type: 'failed', currentVersion: '0.0.1', latestVersion: '0.0.2', reason: 'npm install failed' }

    showUpdateToast(client, result)

    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({
      body: {
        title: 'opencode-zellij update failed',
        message: 'Failed to update to 0.0.2.',
        variant: 'error',
        duration: 8_000,
      },
    })
  })

  it('does nothing when skipped', () => {
    const { calls, client } = mockClient()
    const result: UpdateResult = { type: 'skipped', reason: 'not installed from npm' }

    showUpdateToast(client, result)

    expect(calls.length).toBe(0)
  })

  it('does nothing when up-to-date', () => {
    const { calls, client } = mockClient()
    const result: UpdateResult = { type: 'up-to-date', currentVersion: '0.0.2' }

    showUpdateToast(client, result)

    expect(calls.length).toBe(0)
  })

  it('swallows toast promise rejection', async () => {
    const client = {
      tui: {
        showToast: () => Promise.reject(new Error('toast failed')),
      },
    }
    const result: UpdateResult = { type: 'updated', fromVersion: '0.0.1', toVersion: '0.0.2' }

    // Should not throw
    showUpdateToast(client, result)
    // Allow microtask queue to process the rejected promise
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})

describe('startAutoUpdateCheck', () => {
  function mockClient(): { calls: unknown[], client: Parameters<typeof startAutoUpdateCheck>[0] } {
    const calls: unknown[] = []
    return {
      calls,
      client: {
        tui: {
          showToast: (options: unknown) => {
            calls.push(options)
            return Promise.resolve()
          },
        },
      },
    }
  }

  it('runs auto-update immediately and shows update toast', async () => {
    const { calls, client } = mockClient()
    const seenImportUrls: string[] = []

    startAutoUpdateCheck(client, 'file:///plugin/dist/index.mjs', async (options) => {
      seenImportUrls.push(options.importMetaUrl)
      return { type: 'updated', fromVersion: '0.0.5', toVersion: '0.0.6' }
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(seenImportUrls).toEqual(['file:///plugin/dist/index.mjs'])
    expect(calls).toEqual([{ body: { title: 'opencode-zellij updated', message: 'Updated to 0.0.6. Restart OpenCode to apply the changes.', variant: 'success', duration: 10_000 } }])
  })

  it('swallows rejected update checks', async () => {
    const { calls, client } = mockClient()

    startAutoUpdateCheck(client, 'file:///plugin/dist/index.mjs', async () => {
      throw new Error('network failed')
    })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(calls).toEqual([])
  })

  it('swallows synchronous toast failures from update checks', async () => {
    const client = {
      tui: {
        showToast: () => {
          throw new Error('toast failed')
        },
      },
    }

    startAutoUpdateCheck(client, 'file:///plugin/dist/index.mjs', async () => ({ type: 'updated', fromVersion: '0.0.5', toVersion: '0.0.6' }))

    await new Promise(resolve => setTimeout(resolve, 10))
  })
})
