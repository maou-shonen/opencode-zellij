import type { Plugin } from '@opencode-ai/plugin'
import type { V2PluginContext, V2ToolEditor } from './opencode/v2-tools.js'
import type { CompletionNotificationContext, CompletionNotificationManager } from './zellij/completion-notifications.js'
import type { OpenCodeEventLike } from './zellij/tab-title-events.js'
import process from 'node:process'
import { loadConfig } from './config.js'
import { v2EventToActivityEvent } from './opencode/v2-event.js'
import { addV2Tool } from './opencode/v2-tools.js'
import { configureSudoPane } from './permissions/sudo-pane.js'
import { sessionManager } from './pty/manager.js'
import { zellijPtyKillTool } from './tools/kill.js'
import { zellijPtyListTool } from './tools/list.js'
import { createZellijPtyReadTool } from './tools/read.js'
import { createRequestSudoTool } from './tools/request-sudo.js'
import { zellijPtySpawnTool } from './tools/spawn.js'
import { zellijPtyWriteTool } from './tools/write.js'
import { debug } from './utils/debug.js'
import { errorMessage } from './utils/errors.js'
import { SessionCompletionNotificationManager } from './zellij/completion-notifications.js'
import { cleanupStaleWatchdogRegistries, unregisterPaneFromWatchdog } from './zellij/pane-watchdog.js'
import { registerShutdownCleanup } from './zellij/shutdown-cleanup.js'
import { subscriberManager } from './zellij/subscribe.js'
import { deletedSessionID } from './zellij/tab-title-events.js'
import { TabTitleActivityModel, TabTitleActor, TabTitleManager } from './zellij/tab-title.js'

const PLUGIN_ID = 'opencode-zellij'

function createPtyTools(defaultCleanupExitedPaneOnRead: boolean) {
  return {
    zellij_pty_spawn: zellijPtySpawnTool,
    zellij_pty_list: zellijPtyListTool,
    zellij_pty_write: zellijPtyWriteTool,
    zellij_pty_read: createZellijPtyReadTool({ defaultCleanupExitedPaneOnRead }),
    zellij_pty_kill: zellijPtyKillTool,
  }
}

function getWorkspaceRoot(input: { directory?: string | undefined, worktree?: string | undefined }): string {
  return input.worktree || input.directory || process.cwd()
}

async function cleanupStep(stepName: string, sessionId: string, step: () => void | Promise<void>): Promise<void> {
  try {
    await step()
  }
  catch (error) {
    debug(`session.deleted cleanup failed: ${stepName} for ${sessionId}`, errorMessage(error))
  }
}

async function cleanupDeletedSession(sessionId: string): Promise<void> {
  await cleanupStep('close pane', sessionId, () => subscriberManager.closeSessionPane(sessionId))
  await cleanupStep('forget subscriber', sessionId, () => subscriberManager.forget(sessionId))
  await cleanupStep('unregister watchdog', sessionId, () => unregisterPaneFromWatchdog(sessionId))
  await cleanupStep('remove session', sessionId, () => sessionManager.remove(sessionId))
}

export interface ZellijPtyPluginDependencies {
  createCompletionNotifications?: (context: CompletionNotificationContext) => CompletionNotificationManager | undefined
}

interface RuntimeInput {
  directory?: string | undefined
  worktree?: string | undefined
  client?: { session?: CompletionNotificationContext['client']['session'] } | undefined
  serverUrl?: URL | undefined
}

interface StartedRuntime {
  tools: Record<string, import('@opencode-ai/plugin/tool').ToolDefinition>
  register: (editor: V2ToolEditor, resolveDirectory: (sessionID: string) => Promise<string>) => void
  handleEvent: (event: OpenCodeEventLike) => Promise<void>
  dispose: () => void
}

async function startRuntime(
  input: RuntimeInput,
  dependencies: ZellijPtyPluginDependencies,
  prompt?: CompletionNotificationContext['prompt'],
): Promise<StartedRuntime> {
  const { config, warnings } = await loadConfig(input)
  for (const warning of warnings)
    debug(warning)
  configureSudoPane(config.pty.sudoPane === 'allow')
  cleanupStaleWatchdogRegistries()
  registerShutdownCleanup()

  const workspaceRoot = getWorkspaceRoot(input)
  const activityModel = config.tabTitle.enabled
    ? new TabTitleActivityModel({
        worktreeDirectory: workspaceRoot,
      })
    : undefined
  const actor = activityModel
    ? new TabTitleActor({
        activity: activityModel,
      })
    : undefined
  const tabTitleManager = config.tabTitle.enabled && actor
    ? new TabTitleManager({
        actor,
        debounceMs: config.tabTitle.debounceMs,
        emojis: {
          idle: config.tabTitle.emojiIdle,
          running: config.tabTitle.emojiRunning,
          needsInput: config.tabTitle.emojiNeedsInput,
        },
      })
    : undefined

  const notificationContext: CompletionNotificationContext = {
    client: input.client?.session ? { session: input.client.session } : {},
    ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    ...(prompt ? { prompt } : {}),
  }
  const completionNotifications = dependencies.createCompletionNotifications?.(notificationContext)
    ?? new SessionCompletionNotificationManager(notificationContext)
  subscriberManager.setLifecycleHooks({
    onSessionTerminal: event => void completionNotifications.handleSessionTerminal(event)
      .catch(error => debug('completion notification lifecycle hook failed', errorMessage(error))),
  })

  tabTitleManager?.renderImmediate()
    .catch(error => debug('initial tab title render failed', errorMessage(error)))

  const ptyTools = createPtyTools(config.pty.cleanupExitedPaneOnRead)
  const sudoTool = createRequestSudoTool({
    mode: config.pty.sudoPaneMode,
    floatingSize: config.pty.sudoPaneFloatingSize,
  })
  const tools = config.pty.enabled
    ? {
        ...ptyTools,
        ...(config.pty.sudoPane === 'hide' ? {} : { zellij_pty_request_sudo: sudoTool }),
      }
    : {}

  return {
    tools,
    register(editor, resolveDirectory) {
      if (!config.pty.enabled)
        return
      addV2Tool(editor, 'zellij_pty_spawn', ptyTools.zellij_pty_spawn, resolveDirectory)
      addV2Tool(editor, 'zellij_pty_list', ptyTools.zellij_pty_list, resolveDirectory)
      addV2Tool(editor, 'zellij_pty_write', ptyTools.zellij_pty_write, resolveDirectory)
      addV2Tool(editor, 'zellij_pty_read', ptyTools.zellij_pty_read, resolveDirectory)
      addV2Tool(editor, 'zellij_pty_kill', ptyTools.zellij_pty_kill, resolveDirectory)
      if (config.pty.sudoPane !== 'hide')
        addV2Tool(editor, 'zellij_pty_request_sudo', sudoTool, resolveDirectory)
    },
    async handleEvent(event) {
      if (actor && tabTitleManager) {
        await actor.handleEvent(event)
        tabTitleManager.scheduleUpdate()
      }
      if (event.type === 'server.instance.disposed' || event.type === 'global.disposed') {
        completionNotifications.dispose()
        subscriberManager.setLifecycleHooks(undefined)
      }
      if (event.type === 'session.deleted') {
        const sessionID = deletedSessionID(event)
        if (!sessionID)
          return
        const sessions = sessionManager.listByOpenCodeSession(sessionID)
        await Promise.all(sessions.map(session => cleanupDeletedSession(session.id)))
      }
    },
    dispose() {
      completionNotifications.dispose()
      subscriberManager.setLifecycleHooks(undefined)
    },
  }
}

export function createZellijPtyPlugin(dependencies: ZellijPtyPluginDependencies = {}): Plugin {
  return async (input) => {
    const runtime = await startRuntime(input, dependencies)
    return {
      async event(eventInput) {
        await runtime.handleEvent(eventInput.event)
      },
      tool: runtime.tools,
    }
  }
}

async function sessionDirectory(ctx: V2PluginContext, sessionID: string, fallback: string): Promise<string> {
  if (!ctx.session.get)
    return fallback
  try {
    const session = await ctx.session.get({ sessionID })
    const directory = session?.location?.directory
    if (directory)
      return directory
  }
  catch (error) {
    debug('session directory lookup failed', errorMessage(error))
  }
  return fallback
}

async function consumeV2Events(
  ctx: V2PluginContext,
  signal: AbortSignal,
  handleEvent: (event: OpenCodeEventLike) => Promise<void>,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      const activityEvent = v2EventToActivityEvent(event)
      if (!activityEvent)
        continue
      await handleEvent(activityEvent)
    }
  }
  catch (error) {
    if (signal.aborted)
      return
    debug('v2 event subscription failed', errorMessage(error))
  }
}

export async function setupZellijPtyPlugin(
  ctx: V2PluginContext,
  dependencies: ZellijPtyPluginDependencies = {},
): Promise<() => void> {
  const directory = ctx.location.project?.directory ?? ctx.location.directory
  const worktree = ctx.location.directory
  const runtime = await startRuntime({ directory, worktree }, dependencies, async (sessionID, text) => {
    await ctx.session.prompt({ sessionID, text })
  })
  if (Object.keys(runtime.tools).length > 0) {
    await ctx.tool.transform((editor) => {
      runtime.register(editor, sessionID => sessionDirectory(ctx, sessionID, worktree))
    })
  }
  const controller = new AbortController()
  const subscription = consumeV2Events(ctx, controller.signal, event => runtime.handleEvent(event))
  return () => {
    controller.abort()
    runtime.dispose()
    void subscription
  }
}

export const ZellijPtyPlugin: Plugin = createZellijPtyPlugin()

// V1 calls server(). V2 calls setup(). Both have to live on the default export,
// or the loader for that OpenCode version never finds this plugin.
const pluginModule = {
  id: PLUGIN_ID,
  server: ZellijPtyPlugin,
  setup(ctx: V2PluginContext) {
    return setupZellijPtyPlugin(ctx)
  },
}

export default pluginModule
