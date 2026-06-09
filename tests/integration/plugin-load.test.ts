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
  default: {
    id: string
    server: (input: Record<string, unknown>, options?: unknown) => Promise<PluginHooks>
  }
}

const builtPluginPath = pathToFileURL(join(process.cwd(), 'dist/index.mjs')).href
const ptyToolNames = [
  'zellij_pty_kill',
  'zellij_pty_list',
  'zellij_pty_read',
  'zellij_pty_request_sudo',
  'zellij_pty_spawn',
  'zellij_pty_write',
]
const ptyToolNamesWithoutSudo = ptyToolNames.filter(name => name !== 'zellij_pty_request_sudo')

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
    return mod.default.server({
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

  function clientWithStatus(): Record<string, unknown> {
    return {
      session: {
        status: async () => ({ data: {} }),
      },
    }
  }

  function toolContext(): {
    sessionID: string
    messageID: string
    agent: string
    directory: string
    worktree: string
    abort: AbortSignal
    metadata: () => void
    ask: () => never
  } {
    return {
      sessionID: 'integration-session',
      messageID: 'integration-message',
      agent: 'integration',
      directory: projectRoot(),
      worktree: projectRoot(),
      abort: new AbortController().signal,
      metadata() {},
      ask() {
        throw new Error('ask is not available in built plugin integration tests')
      },
    }
  }

  it('loads built plugin and exposes the hook/tool surface', async () => {
    await writeProjectConfig('{ "tabTitle": { "enabled": true }, "autoUpdate": false }')

    const hooks = await loadBuiltPlugin(clientWithStatus())

    try {
      expect(typeof hooks.event).toBe('function')
      expect(Object.keys(hooks.tool).sort()).toEqual(ptyToolNames)
    }
    finally {
      await disposeQuietly(hooks)
    }
  })

  it('omits built PTY tools when pty.enabled is false', async () => {
    await writeProjectConfig('{ "pty": { "enabled": false }, "autoUpdate": false }')

    const hooks = await loadBuiltPlugin(clientWithStatus())

    try {
      expect(typeof hooks.event).toBe('function')
      expect(hooks.tool).toEqual({})
    }
    finally {
      await disposeQuietly(hooks)
    }
  })

  it('hides the built sudo tool when sudoPane is hide', async () => {
    await writeProjectConfig('{ "pty": { "sudoPane": "hide" }, "autoUpdate": false }')

    const hooks = await loadBuiltPlugin(clientWithStatus())

    try {
      expect(Object.keys(hooks.tool).sort()).toEqual(ptyToolNamesWithoutSudo)
    }
    finally {
      await disposeQuietly(hooks)
    }
  })

  it('keeps the built sudo tool visible but denies execution when sudoPane is deny', async () => {
    await writeProjectConfig('{ "pty": { "sudoPane": "deny" }, "autoUpdate": false }')

    const hooks = await loadBuiltPlugin(clientWithStatus())

    try {
      expect(Object.keys(hooks.tool).sort()).toEqual(ptyToolNames)
      const requestSudoTool = hooks.tool.zellij_pty_request_sudo
      expect(requestSudoTool).toBeDefined()
      if (!requestSudoTool)
        throw new Error('Expected built sudo tool to be present')

      await expect(
        requestSudoTool.execute(
          {
            summary: 'Integration deny smoke.',
            scripts: [{ command: 'echo deny-smoke', description: 'Smoke check disabled sudo pane behavior.' }],
          },
          toolContext(),
        ),
      ).rejects.toThrow(/sudo pane is disabled by zellij-pty config/)
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
