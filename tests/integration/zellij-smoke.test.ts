import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  event?: (input: { event: { type: string, properties?: unknown } }) => void | Promise<void>
}

interface ZellijTabInfo {
  tab_id?: number | string | undefined
  name?: string | undefined
  title?: string | undefined
  active?: boolean | undefined
  is_plugin?: boolean | undefined
}

interface ZellijPaneInfo {
  id?: number | string | undefined
  pane_id?: number | string | undefined
  tab_id?: number | string | undefined
  is_plugin?: boolean | undefined
}

interface PluginModule {
  default: (input: unknown, options?: unknown) => Promise<PluginHooks>
}

const canRunIntegration = process.env.RUN_ZELLIJ_INTEGRATION === '1' && Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME)
const integration = canRunIntegration ? describe : describe.skip
const integrationTimeoutMs = 15_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runZellij(args: string[], timeoutMs = 5_000): Promise<string> {
  const sessionName = process.env.ZELLIJ_SESSION_NAME?.trim()
  const zellijArgs = sessionName ? ['--session', sessionName, ...args] : args
  const result = await execFileAsync('zellij', zellijArgs, { encoding: 'utf8', timeout: timeoutMs })
  return result.stdout ?? ''
}

async function currentPaneTabId(): Promise<number | undefined> {
  const paneId = process.env.ZELLIJ_PANE_ID
  if (!paneId)
    return undefined
  const parsedPaneId = Number(paneId)
  if (!Number.isInteger(parsedPaneId))
    return undefined
  const output = await runZellij(['action', 'list-panes', '--json'])
  let panes: ZellijPaneInfo[] = []
  try {
    const parsed = JSON.parse(output)
    panes = Array.isArray(parsed) ? parsed as ZellijPaneInfo[] : []
  }
  catch {
    return undefined
  }
  const pane = panes.find(p => !p.is_plugin && (Number(p.id) === parsedPaneId || Number(p.pane_id) === parsedPaneId))
  return pane?.tab_id !== undefined ? Number(pane.tab_id) : undefined
}

async function currentTabTitle(): Promise<string | undefined> {
  const tabId = await currentPaneTabId()
  const output = await runZellij(['action', 'list-tabs', '--json'])
  let tabs: ZellijTabInfo[] = []
  try {
    const parsed = JSON.parse(output)
    tabs = Array.isArray(parsed) ? parsed as ZellijTabInfo[] : []
  }
  catch {
    return undefined
  }
  if (tabId !== undefined) {
    const tab = tabs.find(t => Number(t.tab_id) === tabId)
    return tab?.name ?? tab?.title
  }
  return undefined
}

async function renameTabById(tabId: number | undefined, title: string): Promise<void> {
  if (tabId === undefined)
    return
  await runZellij(['action', 'rename-tab', '--tab-id', String(tabId), title])
}

async function waitForTabTitle(
  predicate: (title: string | undefined) => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const intervalMs = 250
  const maxAttempts = Math.floor(timeoutMs / intervalMs)
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    try {
      const title = await currentTabTitle()
      if (predicate(title))
        return true
    }
    catch {
      // keep polling
    }
  }
  return false
}

async function disposeQuietly(hooks: PluginHooks | undefined): Promise<void> {
  if (!hooks?.event)
    return
  try {
    await hooks.event({ event: { type: 'server.instance.disposed', properties: {} } })
  }
  catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Suite-level title guard
// ---------------------------------------------------------------------------

const savedTitle: { value: string | undefined } = { value: undefined }
const savedTabId: { value: number | undefined } = { value: undefined }
const suiteEnabled: boolean = canRunIntegration

integration('real Zellij integration', () => {
  beforeAll(async () => {
    if (!suiteEnabled)
      return
    try {
      savedTabId.value = await currentPaneTabId()
      savedTitle.value = await currentTabTitle()
    }
    catch {
      savedTitle.value = undefined
      savedTabId.value = undefined
    }
  })

  afterAll(async () => {
    if (!suiteEnabled || savedTitle.value === undefined)
      return
    try {
      await renameTabById(savedTabId.value, savedTitle.value)
    }
    catch {
      // best-effort
    }
  })

  // -------------------------------------------------------------------------
  // Each test that loads the plugin must clean up via disposed.
  // -------------------------------------------------------------------------

  it('loads the built plugin tool surface', async () => {
    const hooks = await loadPlugin()
    try {
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
  }, integrationTimeoutMs)

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
      await disposeQuietly(hooks)
    }
  }, integrationTimeoutMs)

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
      await disposeQuietly(hooks)
    }
  }, integrationTimeoutMs)

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
      await disposeQuietly(hooks)
    }
  }, integrationTimeoutMs)

  it('restores tab title after disposed event', async () => {
    // Require pane context so we target the right tab and not an arbitrary active tab
    if (!process.env.ZELLIJ || !process.env.ZELLIJ_PANE_ID)
      return

    const originalTabTitle = await currentTabTitle()
    const tabId = await currentPaneTabId()
    if (tabId === undefined)
      return
    const uniqueOriginalTitle = `opencode-zellij-restore-${Date.now()}`

    await renameTabById(tabId, uniqueOriginalTitle)

    const hooks = await loadPlugin()
    expect(hooks.event).toBeDefined()

    try {
      // Trigger a dynamic title via session.status busy
      await hooks.event!({
        event: {
          type: 'session.status',
          properties: { sessionID: 'test-session', status: { type: 'busy' } },
        },
      })

      const dynamicTitleSeen = await waitForTabTitle(
        title => title !== undefined && title !== uniqueOriginalTitle,
      )
      expect(dynamicTitleSeen).toBe(true)

      // Fire disposed and await
      await hooks.event!({ event: { type: 'server.instance.disposed', properties: {} } })

      const restored = await waitForTabTitle(title => title === uniqueOriginalTitle)
      expect(restored).toBe(true)
    }
    finally {
      await disposeQuietly(hooks)
      // Restore original title (null/undefined check handles empty string case)
      if (originalTabTitle !== undefined) {
        try {
          await renameTabById(tabId, originalTabTitle)
        }
        catch {
          // best-effort
        }
      }
    }
  }, integrationTimeoutMs)
})

// ---------------------------------------------------------------------------
// Remaining helpers (keep after integration suite so file reads cleanly)
// ---------------------------------------------------------------------------

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
