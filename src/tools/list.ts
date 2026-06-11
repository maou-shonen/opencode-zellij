import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, publicSession } from './format.js'

export const zellijPtyListTool = tool({
  description: 'List known Zellij pane-backed PTY sessions created by this plugin process for the current OpenCode session.',
  args: {},
  async execute(_args, context) {
    const sessions = sessionManager.listByOpenCodeSession(context.sessionID).map(session => ({
      ...publicSession(session, { includeTombstone: true }),
      subscriber: subscriberManager.status(session.id),
    }))
    return jsonResponse({ sessions })
  },
})
