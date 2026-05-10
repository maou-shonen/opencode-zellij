import { describe, expect, it } from 'bun:test'

interface ToolContext {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata: (input: { title?: string, metadata?: Record<string, unknown> }) => void
  ask: () => never
}

interface ToolDefinition {
  execute: (args: unknown, context: ToolContext) => Promise<string>
}

interface PluginHooks {
  tool: Record<string, ToolDefinition>
}

interface PluginModule {
  default: (input: unknown, options?: unknown) => Promise<PluginHooks>
}

const canRunIntegration = process.env.RUN_ZELLIJ_INTEGRATION === '1' && Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME)
const integration = canRunIntegration ? describe : describe.skip

function context(): ToolContext {
  return {
    sessionID: `integration-${Date.now()}`,
    messageID: 'integration-message',
    agent: 'integration',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error('ask is not available in integration tests')
    },
  }
}

async function loadPlugin(): Promise<PluginHooks> {
  const mod = (await import(`../../dist/index.mjs?integration=${Date.now()}`)) as PluginModule
  return mod.default({})
}

async function killQuietly(hooks: PluginHooks, id: string, ctx: ToolContext): Promise<void> {
  try {
    await getTool(hooks, 'zellij_pty_kill').execute({ id }, ctx)
  }
  catch (error) {
    // Best-effort cleanup; keep tests focused on the primary assertion unless debug is enabled.
    if (process.env.ZELLIJ_PTY_DEBUG)
      console.warn('killQuietly failed', error instanceof Error ? error.message : String(error))
  }
}

function getTool(hooks: PluginHooks, name: string): ToolDefinition {
  const tool = hooks.tool[name]
  if (!tool)
    throw new Error(`Missing tool: ${name}`)
  return tool
}

integration('real Zellij integration', () => {
  it('loads the built plugin tool surface', async () => {
    const hooks = await loadPlugin()

    expect(Object.keys(hooks.tool).sort()).toEqual([
      'zellij_pty_kill',
      'zellij_pty_list',
      'zellij_pty_read',
      'zellij_pty_request_sudo',
      'zellij_pty_spawn',
      'zellij_pty_write',
    ])
  })

  it('spawns a pane, probes output, reads with grep, and kills it', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    const spawned = JSON.parse(
      await getTool(hooks, 'zellij_pty_spawn').execute(
        {
          command: 'bash',
          args: ['-lc', 'echo integration-ready; sleep 5'],
          probe: { type: 'output', grep: 'integration-ready', timeoutSeconds: 5 },
          maxLines: 50,
        },
        ctx,
      ),
    )

    try {
      expect(spawned.probe.ok).toBe(true)
      expect(spawned.output.text).toContain('integration-ready')

      const read = JSON.parse(await getTool(hooks, 'zellij_pty_read').execute({ id: spawned.session.id, grep: 'integration-ready', maxLines: 50 }, ctx))
      expect(read.output.text).toContain('integration-ready')
    }
    finally {
      await killQuietly(hooks, spawned.session.id, ctx)
    }
  })

  it('writes to an interactive pane and observes output', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    const spawned = JSON.parse(await getTool(hooks, 'zellij_pty_spawn').execute({ command: 'cat', probe: { type: 'sleep', seconds: 0.2 }, maxLines: 50 }, ctx))

    try {
      const written = JSON.parse(await getTool(hooks, 'zellij_pty_write').execute({ id: spawned.session.id, data: 'integration-write-ok\n', maxLines: 50 }, ctx))
      expect(written.output.text).toContain('integration-write-ok')
    }
    finally {
      await killQuietly(hooks, spawned.session.id, ctx)
    }
  })

  it('creates zellij_pty_request_sudo as human-only and rejects agent writes', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    const requested = JSON.parse(
      await getTool(hooks, 'zellij_pty_request_sudo').execute(
        {
          summary: 'Harmless integration sudo request smoke.',
          scripts: [{ command: 'echo request-sudo-ok', description: 'Print a harmless marker after user approval.' }],
        },
        ctx,
      ),
    )

    try {
      expect(requested.session.humanInputOnly).toBe(true)
      expect(requested.session.agentWritable).toBe(false)

      const write = JSON.parse(await getTool(hooks, 'zellij_pty_write').execute({ id: requested.session.id, data: 'SHOULD_NOT_WRITE\n' }, ctx))
      expect(write.next.retryable).toBe(false)
      expect(write.warnings.join('\n')).toContain('forbidden')
    }
    finally {
      await killQuietly(hooks, requested.session.id, ctx)
    }
  })
})
