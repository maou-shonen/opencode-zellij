import type { Plugin, PluginModule } from '@opencode-ai/plugin'
import type { CompletionNotificationContext, CompletionNotificationManager } from './zellij/completion-notifications.js'
import type { OpenCodeEventLike } from './zellij/tab-title-events.js'
import process from 'node:process'
import { loadConfig } from './config.js'
import { configureSudoPane } from './permissions/sudo-pane.js'
import { sessionManager } from './pty/manager.js'
import { zellijPtyKillTool } from './tools/kill.js'
import { zellijPtyListTool } from './tools/list.js'
import { createZellijPtyReadTool } from './tools/read.js'
import { requestSudoTool } from './tools/request-sudo.js'
import { zellijPtySpawnTool } from './tools/spawn.js'
import { zellijPtyWriteTool } from './tools/write.js'
import { debug } from './utils/debug.js'
import { errorMessage } from './utils/errors.js'
import { isOpencodeTuiMode } from './utils/runtime.js'
import { SessionCompletionNotificationManager } from './zellij/completion-notifications.js'
import { cleanupStaleWatchdogRegistries, unregisterPaneFromWatchdog } from './zellij/pane-watchdog.js'
import { registerShutdownCleanup } from './zellij/shutdown-cleanup.js'
import { subscriberManager } from './zellij/subscribe.js'
import { deletedSessionID, getInitialBranch, shouldReadInitialBranch } from './zellij/tab-title-events.js'
import { TabTitleActivityModel, TabTitleActor, TabTitleIdentityModel, TabTitleManager } from './zellij/tab-title.js'

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

function getProjectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || 'opencode'
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

export function createZellijPtyPlugin(dependencies: ZellijPtyPluginDependencies = {}): Plugin {
  return async (input) => {
    // Headless `opencode run` has no UI to render toasts, prompts, or
    // Zellij panes, and the plugin's lifecycle hooks misbehave when the
    // owning process exits without firing the expected teardown events.
    // Short-circuit to a no-op outside the TUI so we don't leak watchdogs,
    // tab-title actors, or completion notifiers into a session that can't
    // observe them.
    if (!isOpencodeTuiMode()) {
      debug('opencode-zellij disabled: not running inside an OpenCode TUI session')
      return {}
    }

    const { config, warnings } = await loadConfig(input)
    for (const warning of warnings) {
      debug(warning)
    }
    configureSudoPane(config.pty.sudoPane === 'allow')
    cleanupStaleWatchdogRegistries()
    registerShutdownCleanup()

    const workspaceRoot = getWorkspaceRoot(input)
    const projectName = getProjectName(workspaceRoot)
    const identityModel = config.tabTitle.enabled
      ? new TabTitleIdentityModel({
          projectName,
          worktree: workspaceRoot,
          readBranch: async worktree => shouldReadInitialBranch(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) ? (await getInitialBranch(worktree)) ?? '' : '',
        })
      : undefined
    const activityModel = config.tabTitle.enabled
      ? new TabTitleActivityModel({
          worktreeDirectory: workspaceRoot,
        })
      : undefined
    const actor = identityModel && activityModel
      ? new TabTitleActor({
          identity: identityModel,
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
            branch: config.tabTitle.emojiBranch,
          },
        })
      : undefined

    const completionNotifications = dependencies.createCompletionNotifications?.({
      client: { session: input.client?.session },
      serverUrl: input.serverUrl,
    }) ?? new SessionCompletionNotificationManager({
      client: { session: input.client?.session },
      serverUrl: input.serverUrl,
    })
    subscriberManager.setLifecycleHooks({
      onSessionTerminal: event => void completionNotifications.handleSessionTerminal(event)
        .catch(error => debug('completion notification lifecycle hook failed', errorMessage(error))),
    })

    // Best-effort initial render; no-op when not inside a real Zellij pane.
    if (actor) {
      await actor.ready
    }
    tabTitleManager?.renderImmediate()
      .catch(error => debug('initial tab title render failed', errorMessage(error)))

    return {
      async event(input) {
        const event: OpenCodeEventLike = input.event

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
      tool: config.pty.enabled
        ? {
            ...createPtyTools(config.pty.cleanupExitedPaneOnRead),
            ...(config.pty.sudoPane === 'hide' ? {} : { zellij_pty_request_sudo: requestSudoTool }),
          }
        : {},
    }
  }
}

// Default export follows the V1 PluginModule shape expected by opencode's
// plugin loader (`@opencode-ai/plugin` PluginModule = { id?, server, tui?: never }).
// The `id` is required for file plugins; opencode uses it to identify the
// plugin in logs and `resolvePluginId`. `server` is the plugin factory
// (a `Plugin` = `(input, options) => Promise<Hooks>`).
//
// `ZellijPtyPlugin` is also re-exported as a named symbol for tests and
// internal callers that need the raw factory; it is no longer the default
// export so that opencode's `readV1Plugin` finds the expected object shape
// instead of falling through to the legacy `getLegacyPlugins` path, which
// would otherwise try to invoke every other named export as a plugin.
export const ZellijPtyPlugin: Plugin = createZellijPtyPlugin()

export default {
  id: PLUGIN_ID,
  server: ZellijPtyPlugin,
} satisfies Pick<PluginModule, 'id' | 'server'>
