import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface PluginHooks {
  tool: Record<string, { execute: (args: unknown, context: unknown) => Promise<string> }>
  event?: (input: unknown) => Promise<void> | void
}

interface PluginModule {
  default: (input: Record<string, unknown>, options?: unknown) => Promise<PluginHooks>
}

const builtPluginPath = pathToFileURL(join(process.cwd(), 'dist/index.mjs')).href

describe('built plugin integration load', () => {
  let tempRoot = ''
  let originalXdgConfigHome: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-integration-'))
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

  function projectRoot(): string {
    return join(tempRoot, 'project')
  }

  async function writeProjectConfig(content: string): Promise<void> {
    const configDir = join(projectRoot(), '.opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode-zellij.config.jsonc'), content)
  }

  async function loadBuiltPlugin(client: Record<string, unknown>): Promise<PluginHooks> {
    const mod = (await import(`${builtPluginPath}?integration=${Date.now()}-${Math.random()}`)) as PluginModule
    return mod.default({
      directory: projectRoot(),
      worktree: projectRoot(),
      client,
    })
  }

  async function disposeQuietly(hooks: PluginHooks | undefined): Promise<void> {
    try {
      await hooks?.event?.({ event: { type: 'server.instance.disposed', properties: {} } })
    }
    catch {
      // best-effort cleanup for integration load tests
    }
  }

  it('loads built plugin and exposes the hook/tool surface', async () => {
    await writeProjectConfig('{ "tabTitle": { "enabled": true }, "autoUpdate": false }')

    const hooks = await loadBuiltPlugin({
      session: {
        status: async () => ({ data: {} }),
      },
    })

    try {
      expect(typeof hooks.event).toBe('function')
      expect(Object.keys(hooks.tool).sort()).toEqual([
        'zellij_pty_kill',
        'zellij_pty_list',
        'zellij_pty_read',
        'zellij_pty_request_sudo',
        'zellij_pty_spawn',
        'zellij_pty_write',
      ])
    }
    finally {
      await disposeQuietly(hooks)
    }
  })

  it('loads built plugin without waiting for startup status snapshot', async () => {
    await writeProjectConfig('{ "tabTitle": { "enabled": true }, "autoUpdate": false }')

    const result = await Promise.race([
      loadBuiltPlugin({
        session: {
          status: async () => new Promise(() => {}),
        },
      }).then(hooks => ({ status: 'resolved' as const, hooks })),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 250)),
    ])

    expect(result).not.toBe('timeout')
    await disposeQuietly((result as { hooks?: PluginHooks }).hooks)
  })
})
