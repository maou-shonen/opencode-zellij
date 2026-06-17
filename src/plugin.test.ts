import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zellijPlugin, { createZellijPtyPlugin } from './plugin.js'
import { SessionCompletionNotificationManager } from './zellij/completion-notifications.js'

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

  it('fires the completion prompt the moment a pane exits', async () => {
    const project = join(tempRoot, 'project')
    const prompts: Array<Record<string, unknown>> = []
    let manager: SessionCompletionNotificationManager | undefined
    const pluginFactory = createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        manager = new SessionCompletionNotificationManager(context)
        return manager
      },
    })

    await pluginFactory(pluginInput(project, {
      client: {
        session: {
          promptAsync: async (request: Record<string, unknown>) => {
            prompts.push(request)
          },
        },
      },
    }), {})

    const session = {
      id: 'zpty_prompt_test',
      openCodeSessionId: 'session_a',
      paneId: 'terminal_prompt',
      title: 'prompt test',
      command: 'bash',
      args: [],
      cwd: process.cwd(),
      status: 'terminal' as const,
      lineCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      allowAgentInput: true,
      humanInputOnly: false,
      exitCode: 0,
      exitedAt: null,
      exitCodeToken: null,
      tombstone: null,
    }

    // Trigger the terminal event through the manager that the plugin
    // constructed. The factory captured it via the closure above.
    await manager?.handleSessionTerminal({ sessionId: session.id, reason: 'exit_marker', session })

    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] as { sessionID: string, parts: Array<{ type: string, text: string }> }
    expect(prompt.sessionID).toBe('session_a')
    expect(prompt.parts[0]?.type).toBe('text')
    expect(prompt.parts[0]?.text).toContain('[zellij_pty]')
    expect(prompt.parts[0]?.text).toContain('terminal_prompt')
    expect(prompt.parts[0]?.text).toContain('exit=0')
    expect(prompt.parts[0]?.text).toContain('zellij_pty_read')
    expect(prompt.parts[0]?.text).toContain('zellij_pty_kill')
  })

  it('falls back to client.session.prompt when promptAsync is unavailable', async () => {
    const project = join(tempRoot, 'project')
    const prompts: Array<Record<string, unknown>> = []
    let manager: SessionCompletionNotificationManager | undefined
    const pluginFactory = createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        manager = new SessionCompletionNotificationManager(context)
        return manager
      },
    })
    await pluginFactory(pluginInput(project, {
      client: {
        session: {
          prompt: async (request: Record<string, unknown>) => {
            prompts.push(request)
          },
        },
      },
    }), {})

    const session = {
      id: 'zpty_fallback',
      openCodeSessionId: 'session_b',
      paneId: 'terminal_fallback',
      title: 'fallback test',
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

    await manager?.handleSessionTerminal({ sessionId: session.id, reason: 'exit_marker', session })

    expect(prompts).toHaveLength(1)
  })

  it('logs and continues when the prompt call rejects (e.g. MessageAbortedError)', async () => {
    const project = join(tempRoot, 'project')
    let manager: SessionCompletionNotificationManager | undefined
    const pluginFactory = createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        manager = new SessionCompletionNotificationManager(context)
        return manager
      },
    })

    // Should not throw; should just log.
    await pluginFactory(pluginInput(project, {
      client: {
        session: {
          promptAsync: async () => {
            const err = new Error('Request aborted') as Error & { name: string }
            err.name = 'MessageAbortedError'
            throw err
          },
        },
      },
    }), {})

    const session = {
      id: 'zpty_aborted',
      openCodeSessionId: 'session_c',
      paneId: 'terminal_aborted',
      title: 'aborted test',
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

    await expect(manager?.handleSessionTerminal({ sessionId: session.id, reason: 'exit_marker', session })).resolves.toBeUndefined()
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

  it('always wires the completion manager because pane-completion is unconditional', async () => {
    const project = join(tempRoot, 'project')
    const createNotificationsCalls: unknown[] = []
    await createZellijPtyPlugin({
      createCompletionNotifications: (context) => {
        createNotificationsCalls.push(context)
        return new SessionCompletionNotificationManager(context)
      },
    })(pluginInput(project, {
      client: { session: { promptAsync: async () => {} } },
    }), {})
    expect(createNotificationsCalls).toHaveLength(1)
  })
})
