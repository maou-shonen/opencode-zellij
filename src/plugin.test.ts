import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zellijPlugin, { createZellijPtyPlugin } from './plugin.js'
import { SessionCompletionNotificationQueue } from './zellij/completion-notifications.js'

describe('ZellijPtyPlugin', () => {
  let tempRoot = ''
  let originalXdgConfigHome: string | undefined
  let originalProcessRole: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-plugin-'))
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(tempRoot, 'xdg')
    originalProcessRole = process.env.OPENCODE_PROCESS_ROLE
    process.env.OPENCODE_PROCESS_ROLE = 'worker'
  })

  afterEach(async () => {
    if (originalXdgConfigHome === undefined)
      delete process.env.XDG_CONFIG_HOME
    else
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    if (originalProcessRole === undefined)
      delete process.env.OPENCODE_PROCESS_ROLE
    else
      process.env.OPENCODE_PROCESS_ROLE = originalProcessRole
    await rm(tempRoot, { force: true, recursive: true })
  })

  // Use the inline factory so the helper type is a real `Plugin` instead of
  // the V1 PluginModule object the module now default-exports.
  const pluginFactory = createZellijPtyPlugin()
  function pluginInput(directory: string, input: Record<string, unknown> = {}): Parameters<typeof pluginFactory>[0] {
    return { directory, ...input } as Parameters<typeof pluginFactory>[0]
  }

  async function writeProjectConfig(directory: string, content: string): Promise<void> {
    const configDir = join(directory, '.opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode-zellij.config.jsonc'), content)
  }

  it('default-exports a V1 PluginModule with id and server', () => {
    expect(typeof zellijPlugin).toBe('object')
    expect(zellijPlugin).not.toBeNull()
    expect((zellijPlugin as { id?: unknown }).id).toBe('opencode-zellij')
    expect(typeof (zellijPlugin as { server?: unknown }).server).toBe('function')
  })

  it('injects queued completion notifications through the top-level chat.message hook', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "pty": { "completionNotification": { "mode": "queue" } } }')
    let queue: SessionCompletionNotificationQueue | undefined
    const pluginFactory = createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        queue = new SessionCompletionNotificationQueue(context)
        return queue
      },
    })

    const plugin = await pluginFactory(pluginInput(project), {}) as {
      'chat.message'?: (input: { sessionID: string }, output: { message: unknown, parts: Array<{ type: string, text?: string }> }) => Promise<unknown>
      chat?: unknown
    }
    const session = {
      id: 'zpty_1',
      openCodeSessionId: 'session_a',
      paneId: 'terminal_1',
      title: 'queued demo',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      status: 'terminal' as const,
      lineCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      allowAgentInput: true,
      humanInputOnly: false,
      exitCode: null,
      exitedAt: null,
      exitCodeToken: null,
      tombstone: null,
    }

    await queue?.handleSessionTerminal({ sessionId: session.id, reason: 'exit_marker', session })
    const input = { sessionID: 'session_a' }
    const originalMessage = { role: 'user', content: 'hello' }
    const output = { message: originalMessage, parts: [{ type: 'text', text: 'hello' }] }

    expect(typeof plugin['chat.message']).toBe('function')
    expect(plugin.chat).toBeUndefined()

    await plugin['chat.message']?.(input, output)

    expect(output.parts[0]).toEqual({ type: 'text', text: '[OpenCode] Zellij PTY completion notice\n- zpty_1 (terminal_1) 已完成，請使用 zellij_pty_read 讀取最終輸出並清理 pane。' })
    expect(output.parts[1]).toEqual({ type: 'text', text: 'hello' })
    expect(output.message).toBe(originalMessage)
    expect(input).toEqual({ sessionID: 'session_a' })
  })

  it('does not inject a queued completion notice after queue+toast delivers an active prompt', async () => {
    const project = join(tempRoot, 'project')
    const prompts: unknown[] = []
    const toasts: unknown[] = []
    let queue: SessionCompletionNotificationQueue | undefined
    const pluginFactory = createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        queue = new SessionCompletionNotificationQueue(context)
        return queue
      },
    })

    const plugin = await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async () => ({ data: { session_a: { type: 'idle' } } }),
          prompt: async (request: unknown) => {
            prompts.push(request)
          },
        },
        tui: {
          showToast: async (payload: unknown) => {
            toasts.push(payload)
          },
        },
      },
    }), {}) as {
      'chat.message'?: (input: { sessionID: string }, output: { message: unknown, parts: Array<{ type: string, text?: string }> }) => Promise<unknown>
    }
    const session = {
      id: 'zpty_2',
      openCodeSessionId: 'session_a',
      paneId: 'terminal_2',
      title: 'prompt demo',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      status: 'terminal' as const,
      lineCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      allowAgentInput: true,
      humanInputOnly: false,
      exitCode: null,
      exitedAt: null,
      exitCodeToken: null,
      tombstone: null,
    }

    await queue?.handleSessionTerminal({ sessionId: session.id, reason: 'exit_marker', session })

    const output = { message: { role: 'user', content: 'hello' }, parts: [{ type: 'text', text: 'hello' }] }
    await plugin['chat.message']?.({ sessionID: 'session_a' }, output)

    expect(prompts).toHaveLength(1)
    expect(toasts).toHaveLength(1)
    expect(output.parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('does not call client.session.status during startup or relevant event handling when tab title enabled', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    let statusCallCount = 0
    const pluginFactory = createZellijPtyPlugin({})
    const plugin = await pluginFactory(pluginInput(project, {
      client: {
        session: {
          status: async () => {
            statusCallCount++
            return { data: {} }
          },
        },
      },
    }), {}) as { event?: (input: { event: unknown }) => Promise<void> }

    // Fire tab-title relevant events; none should call the status API.
    await plugin.event?.({ event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } } })
    await plugin.event?.({ event: { type: 'session.idle', properties: { sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'session.error', properties: { sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'session.created', properties: { sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'session.deleted', properties: { info: { id: 's1' } } } })
    await plugin.event?.({ event: { type: 'question.asked', properties: { id: 'q1', sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'question.replied', properties: { requestID: 'q1', sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'permission.asked', properties: { id: 'p1', sessionID: 's1' } } })
    await plugin.event?.({ event: { type: 'permission.replied', properties: { requestID: 'p1', sessionID: 's1' } } })

    expect(statusCallCount).toBe(0)
  })

  it('short-circuits to a no-op when not running inside an OpenCode TUI session', async () => {
    const project = join(tempRoot, 'project')
    const createNotificationsCalls: unknown[] = []
    const pluginFactory = createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        createNotificationsCalls.push(context)
        return undefined
      },
    })

    // Simulate a headless `opencode run` invocation by clearing the TUI role.
    delete process.env.OPENCODE_PROCESS_ROLE

    const hooks = await pluginFactory(pluginInput(project), {})

    expect(hooks).toEqual({})
    expect(createNotificationsCalls).toEqual([])
  })

  it('does not register PTY tools when not running inside an OpenCode TUI session', async () => {
    const project = join(tempRoot, 'project')
    delete process.env.OPENCODE_PROCESS_ROLE

    const hooks = (await createZellijPtyPlugin()(pluginInput(project), {})) as { tool?: Record<string, unknown> }

    expect(hooks.tool).toBeUndefined()
  })
})
