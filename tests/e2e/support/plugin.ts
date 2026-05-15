import process from 'node:process'

export interface ToolContext {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata: (input: { title?: string, metadata?: Record<string, unknown> }) => void
  ask: () => never
}

export interface ToolDefinition {
  execute: (args: unknown, context: ToolContext) => Promise<string>
}

export interface PluginHooks {
  tool: Record<string, ToolDefinition>
  event?: (input: { event: { type: string, properties?: unknown } }) => void | Promise<void>
}

export interface PluginModule {
  default: (input: unknown, options?: unknown) => Promise<PluginHooks>
}

export function defaultClient(): Record<string, unknown> {
  return {
    session: {
      status: async () => ({ data: {} }),
    },
  }
}

export async function loadPlugin(inputOverrides: { directory?: string, worktree?: string, client?: Record<string, unknown> } = {}): Promise<PluginHooks> {
  const mod = (await import(`../../../dist/index.mjs?integration=${Date.now()}`)) as PluginModule
  return mod.default({
    directory: inputOverrides.directory ?? process.cwd(),
    worktree: inputOverrides.worktree ?? process.cwd(),
    client: inputOverrides.client ?? defaultClient(),
  })
}

export function context(): ToolContext {
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

export async function sendEvent(hooks: PluginHooks, event: { type: string, properties?: unknown }): Promise<void> {
  await hooks.event?.({ event })
}

export async function disposeQuietly(hooks: PluginHooks | undefined): Promise<void> {
  if (!hooks?.event)
    return

  try {
    await sendEvent(hooks, { type: 'server.instance.disposed', properties: {} })
  }
  catch {
    // best-effort
  }
}

export async function killQuietly(hooks: PluginHooks, id: string, ctx: ToolContext): Promise<void> {
  try {
    await getTool(hooks, 'zellij_pty_kill').execute({ id }, ctx)
  }
  catch (error) {
    if (process.env.ZELLIJ_PTY_DEBUG)
      console.warn('killQuietly failed', error instanceof Error ? error.message : String(error))
  }
}

export function getTool(hooks: PluginHooks, name: string): ToolDefinition {
  const tool = hooks.tool[name]
  if (!tool)
    throw new Error(`Missing tool: ${name}`)
  return tool
}
