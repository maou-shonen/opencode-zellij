import type { Plugin } from '@opencode-ai/plugin'
import type { OpenCodeEventLike } from './zellij/tab-title-events.js'
import process from 'node:process'
import { configurePolicy } from './permissions/policy.js'
import { sessionManager } from './pty/manager.js'
import { zellijPtyKillTool } from './tools/kill.js'
import { zellijPtyListTool } from './tools/list.js'
import { zellijPtyReadTool } from './tools/read.js'
import { requestSudoTool } from './tools/request-sudo.js'
import { zellijPtySpawnTool } from './tools/spawn.js'
import { zellijPtyWriteTool } from './tools/write.js'
import { cleanupStaleWatchdogRegistries, unregisterPaneFromWatchdog } from './zellij/pane-watchdog.js'
import { registerShutdownCleanup } from './zellij/shutdown-cleanup.js'
import { subscriberManager } from './zellij/subscribe.js'
import { deletedSessionID, getInitialBranch, handleTabTitleEvent, shouldReadInitialBranch } from './zellij/tab-title-events.js'
import { TabTitleManager } from './zellij/tab-title.js'

function getProjectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || 'opencode'
}

function getWorkspaceRoot(input: { directory?: string | undefined, worktree?: string | undefined }): string {
  return input.worktree || input.directory || process.cwd()
}

export const ZellijPtyPlugin: Plugin = async (input, options) => {
  configurePolicy(options?.zellijPty ?? options)
  cleanupStaleWatchdogRegistries()
  registerShutdownCleanup()

  const workspaceRoot = getWorkspaceRoot(input)
  const projectName = getProjectName(workspaceRoot)
  const branchName = shouldReadInitialBranch(process.env.ZELLIJ) ? await getInitialBranch(workspaceRoot) : undefined
  const tabTitleManager = new TabTitleManager({ projectName, branchName })

  // Best-effort initial render; no-op when not inside a real Zellij pane.
  tabTitleManager.renderImmediate().catch(() => {})

  return {
    async event(input) {
      const event: OpenCodeEventLike = input.event
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
    tool: {
      zellij_pty_spawn: zellijPtySpawnTool,
      zellij_pty_list: zellijPtyListTool,
      zellij_pty_write: zellijPtyWriteTool,
      zellij_pty_read: zellijPtyReadTool,
      zellij_pty_kill: zellijPtyKillTool,
      zellij_pty_request_sudo: requestSudoTool,
    },
  }
}

export default ZellijPtyPlugin
