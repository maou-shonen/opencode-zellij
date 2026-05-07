import type { Plugin } from '@opencode-ai/plugin'
import { configurePolicy } from './permissions/policy.js'
import { sessionManager } from './pty/manager.js'
import { zellijPtyKillTool } from './tools/kill.js'
import { zellijPtyListTool } from './tools/list.js'
import { zellijPtyReadTool } from './tools/read.js'
import { requestSudoTool } from './tools/request-sudo.js'
import { zellijPtySpawnTool } from './tools/spawn.js'
import { zellijPtyWriteTool } from './tools/write.js'
import { subscriberManager } from './zellij/subscribe.js'

export const ZellijPtyPlugin: Plugin = async (_input, options) => {
  configurePolicy(options?.zellijPty ?? options)

  return {
    async event(input) {
      if (input.event.type === 'session.deleted') {
        const sessions = sessionManager.listByOpenCodeSession(input.event.properties.info.id)
        await Promise.all(
          sessions.map(async (session) => {
            await subscriberManager.closeSessionPane(session.id)
            subscriberManager.forget(session.id)
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
