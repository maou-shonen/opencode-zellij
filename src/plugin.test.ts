import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ZellijPtyPlugin from './plugin.js'

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
