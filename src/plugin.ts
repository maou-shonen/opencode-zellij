import type { Plugin } from '@opencode-ai/plugin'
import type { UpdateResult } from './auto-update.js'
import type { OpenCodeEventLike } from './zellij/tab-title-events.js'
import process from 'node:process'
import { checkAndUpdate } from './auto-update.js'
import { loadConfig } from './config.js'
import { configurePolicy } from './permissions/policy.js'
import { sessionManager } from './pty/manager.js'
import { zellijPtyKillTool } from './tools/kill.js'
import { zellijPtyListTool } from './tools/list.js'
import { zellijPtyReadTool } from './tools/read.js'
import { requestSudoTool } from './tools/request-sudo.js'
import { zellijPtySpawnTool } from './tools/spawn.js'
import { zellijPtyWriteTool } from './tools/write.js'
import { debug } from './utils/debug.js'
import { cleanupStaleWatchdogRegistries, unregisterPaneFromWatchdog } from './zellij/pane-watchdog.js'
import { registerShutdownCleanup } from './zellij/shutdown-cleanup.js'
import { subscriberManager } from './zellij/subscribe.js'
import { deletedSessionID, getInitialBranch, handleTabTitleEvent, shouldReadInitialBranch } from './zellij/tab-title-events.js'
import { TabTitleManager } from './zellij/tab-title.js'

const ptyTools = {
  zellij_pty_spawn: zellijPtySpawnTool,
  zellij_pty_list: zellijPtyListTool,
  zellij_pty_write: zellijPtyWriteTool,
  zellij_pty_read: zellijPtyReadTool,
  zellij_pty_kill: zellijPtyKillTool,
}

function getProjectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || 'opencode'
}

function getWorkspaceRoot(input: { directory?: string | undefined, worktree?: string | undefined }): string {
  return input.worktree || input.directory || process.cwd()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
    }).catch(() => {})
  }
  else if (result.type === 'failed') {
    client.tui.showToast({
      body: {
        title: 'opencode-zellij update failed',
        message: `Failed to update to ${result.latestVersion}.`,
        variant: 'error',
        duration: 8_000,
      },
    }).catch(() => {})
  }
}

function isRootSessionCreated(event: OpenCodeEventLike): boolean {
  if (event.type !== 'session.created')
    return false
  if (!isRecord(event.properties))
    return true
  const info = event.properties.info
  if (!isRecord(info))
    return true
  return !info.parentID
}

export const ZellijPtyPlugin: Plugin = async (input) => {
  const { config, warnings } = await loadConfig(input)
  for (const warning of warnings) {
    debug(warning)
  }
  configurePolicy({ allowSudoPane: config.pty.sudoPane === 'allow' })
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

  // Best-effort initial render; no-op when not inside a real Zellij pane.
  tabTitleManager?.renderImmediate().catch(() => {})

  let hasCheckedUpdate = false
  const client = input.client

  return {
    async event(input) {
      const event: OpenCodeEventLike = input.event

      if (!hasCheckedUpdate && config.autoUpdate.enabled && isRootSessionCreated(event)) {
        hasCheckedUpdate = true
        checkAndUpdate({ importMetaUrl: import.meta.url }).then(
          result => showUpdateToast(client, result),
          (cause: unknown) => debug('auto-update check failed', cause instanceof Error ? cause.message : String(cause)),
        )
      }

      if (tabTitleManager)
        handleTabTitleEvent(tabTitleManager, event)

      if (event.type === 'session.deleted') {
        const sessionID = deletedSessionID(event)
        if (!sessionID)
          return

        const sessions = sessionManager.listByOpenCodeSession(sessionID)
        await Promise.all(
          sessions.map(async (session) => {
            await subscriberManager.closeSessionPane(session.id)
            subscriberManager.forget(session.id)
            unregisterPaneFromWatchdog(session.id)
            sessionManager.remove(session.id)
          }),
        )
      }
    },
    tool: config.pty.enabled
      ? {
          ...ptyTools,
          ...(config.pty.sudoPane === 'hide' ? {} : { zellij_pty_request_sudo: requestSudoTool }),
        }
      : {},
  }
}

export default ZellijPtyPlugin
