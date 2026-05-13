import type { Plugin } from '@opencode-ai/plugin'
import type { UpdateResult } from './auto-update.js'
import type { CompletionNotificationClient, CompletionNotificationContext, CompletionNotificationManager } from './zellij/completion-notifications.js'
import type { OpenCodeEventLike } from './zellij/tab-title-events.js'
import process from 'node:process'
import { checkAndUpdate } from './auto-update.js'
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
import { SessionCompletionNotificationQueue } from './zellij/completion-notifications.js'
import { cleanupStaleWatchdogRegistries, unregisterPaneFromWatchdog } from './zellij/pane-watchdog.js'
import { registerShutdownCleanup } from './zellij/shutdown-cleanup.js'
import { subscriberManager } from './zellij/subscribe.js'
import { deletedSessionID, getInitialBranch, handleTabTitleEvent, shouldReadInitialBranch } from './zellij/tab-title-events.js'
import { shouldRefreshTabTitleStatusSnapshot, TabTitleStatusSnapshotRefresher } from './zellij/tab-title-status-snapshot.js'
import { TabTitleManager } from './zellij/tab-title.js'

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

export interface ToastClient {
  tui: {
    showToast: (options: {
      body: {
        title: string
        message: string
        variant: 'success' | 'error'
        duration: number
      }
    }) => Promise<unknown>
  }
}

export function showUpdateToast(client: ToastClient, result: UpdateResult): void {
  if (result.type === 'updated') {
    client.tui.showToast({
      body: {
        title: 'opencode-zellij updated',
        message: `Updated to ${result.toVersion}. Restart OpenCode to apply the changes.`,
        variant: 'success',
        duration: 10_000,
      },
    })
      .catch(error => debug('show update toast for successful update failed', errorMessage(error)))
  }
  else if (result.type === 'failed') {
    client.tui.showToast({
      body: {
        title: 'opencode-zellij update failed',
        message: `Failed to update to ${result.latestVersion}.`,
        variant: 'error',
        duration: 8_000,
      },
    })
      .catch(error => debug('show update toast for failed update failed', errorMessage(error)))
  }
}

export function startAutoUpdateCheck(
  client: ToastClient,
  importMetaUrl: string,
  check: typeof checkAndUpdate = checkAndUpdate,
): void {
  ;(async () => {
    try {
      showUpdateToast(client, await check({ importMetaUrl }))
    }
    catch (cause) {
      debug('auto-update check failed', errorMessage(cause))
    }
  })()
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
  importMetaUrl?: string | undefined
  startAutoUpdateCheck?: typeof startAutoUpdateCheck | undefined
  createCompletionNotifications?: (context: CompletionNotificationContext) => CompletionNotificationManager | undefined
}

export function createZellijPtyPlugin(dependencies: ZellijPtyPluginDependencies = {}): Plugin {
  return async (input) => {
    const { config, warnings } = await loadConfig(input)
    for (const warning of warnings) {
      debug(warning)
    }
    configureSudoPane(config.pty.sudoPane === 'allow')
    cleanupStaleWatchdogRegistries()
    registerShutdownCleanup()

    const workspaceRoot = getWorkspaceRoot(input)
    const projectName = getProjectName(workspaceRoot)
    const branchName = config.tabTitle.enabled && shouldReadInitialBranch(process.env.ZELLIJ) ? await getInitialBranch(workspaceRoot) : undefined
    const tabTitleManager = config.tabTitle.enabled
      ? new TabTitleManager({
          projectName,
          branchName,
          debounceMs: config.tabTitle.debounceMs,
          emojis: {
            idle: config.tabTitle.emojiIdle,
            running: config.tabTitle.emojiRunning,
            needsInput: config.tabTitle.emojiNeedsInput,
            branch: config.tabTitle.emojiBranch,
          },
        })
      : undefined

    const client = input.client
    const completionNotifications = config.pty.completionNotification.mode === 'off'
      ? undefined
      : (dependencies.createCompletionNotifications?.({
          client: client as CompletionNotificationClient,
          workspaceRoot,
          config: config.pty.completionNotification,
          markSent(sessionId) {
            try {
              sessionManager.markTerminalNotificationSent(sessionId)
            }
            catch (error) {
              debug('mark terminal notification sent failed', errorMessage(error))
            }
          },
        }) ?? new SessionCompletionNotificationQueue({
          client: client as CompletionNotificationClient,
          workspaceRoot,
          config: config.pty.completionNotification,
          markSent(sessionId) {
            try {
              sessionManager.markTerminalNotificationSent(sessionId)
            }
            catch (error) {
              debug('mark terminal notification sent failed', errorMessage(error))
            }
          },
        }))

    subscriberManager.setLifecycleHooks(completionNotifications
      ? { onSessionTerminal: event => void completionNotifications.handleSessionTerminal(event).catch(error => debug('completion notification lifecycle hook failed', errorMessage(error))) }
      : undefined)

    // Best-effort initial snapshot so the first rendered title reflects real
    // server state instead of briefly defaulting to idle.  The refresher
    // handles debouncing for subsequent refreshes triggered by events.
    const tabTitleSnapshotRefresher = tabTitleManager
      ? new TabTitleStatusSnapshotRefresher({
          client,
          workspaceRoot,
          manager: tabTitleManager,
          debounceMs: 1_000,
        })
      : undefined

    // Do not block plugin startup on the OpenCode status API: during startup the
    // server may not be ready to answer session.status yet.
    tabTitleSnapshotRefresher?.refreshNow()
      .catch(error => debug('initial tab title snapshot refresh failed', errorMessage(error)))

    // Best-effort initial render; no-op when not inside a real Zellij pane.
    tabTitleManager?.renderImmediate()
      .catch(error => debug('initial tab title render failed', errorMessage(error)))

    if (config.autoUpdate)
      (dependencies.startAutoUpdateCheck ?? startAutoUpdateCheck)(client, dependencies.importMetaUrl ?? import.meta.url)

    return {
      async event(input) {
        const event: OpenCodeEventLike = input.event

        if (tabTitleManager) {
          // Cancel pending snapshot work before manager destroy can await external cleanup.
          if (event.type === 'server.instance.disposed' || event.type === 'global.disposed')
            tabTitleSnapshotRefresher?.dispose()
          await handleTabTitleEvent(tabTitleManager, event)
          if (shouldRefreshTabTitleStatusSnapshot(event))
            tabTitleSnapshotRefresher?.scheduleRefresh()
        }

        if (event.type === 'server.instance.disposed' || event.type === 'global.disposed') {
          completionNotifications?.clearAll()
          completionNotifications?.dispose()
          subscriberManager.setLifecycleHooks(undefined)
        }

        if (event.type === 'session.deleted') {
          const sessionID = deletedSessionID(event)
          if (!sessionID)
            return

          const sessions = sessionManager.listByOpenCodeSession(sessionID)
          for (const session of sessions)
            completionNotifications?.clearSession(session.id)
          await Promise.all(sessions.map(session => cleanupDeletedSession(session.id)))
        }
      },
      'chat.message': async (
        _input: unknown,
        output: { message: unknown, parts: Array<Record<string, unknown> & { type: string }> },
      ) => {
        const injected = completionNotifications?.injectQueuedChatMessage(output) ?? output
        if (injected !== output && injected && typeof injected === 'object' && Array.isArray((injected as { parts?: unknown }).parts))
          output.parts = (injected as { parts: Array<Record<string, unknown> & { type: string }> }).parts
      },
      'tool': config.pty.enabled
        ? {
            ...createPtyTools(config.pty.cleanupExitedPaneOnRead),
            ...(config.pty.sudoPane === 'hide' ? {} : { zellij_pty_request_sudo: requestSudoTool }),
          }
        : {},
    }
  }
}

export const ZellijPtyPlugin: Plugin = createZellijPtyPlugin()

export default ZellijPtyPlugin
