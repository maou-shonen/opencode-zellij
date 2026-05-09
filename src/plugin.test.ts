import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ZellijPtyPlugin, { showUpdateToast } from './plugin.js'
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

  function pluginInput(directory: string): Parameters<typeof ZellijPtyPlugin>[0] {
    return { directory } as Parameters<typeof ZellijPtyPlugin>[0]
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

  it('keeps sudo tool visible when sudoPane is deny', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "pty": { "sudoPane": "deny" } }')
    const plugin = await ZellijPtyPlugin(pluginInput(project), {})

    expect(Object.keys(plugin.tool ?? {})).toContain('zellij_pty_request_sudo')
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
