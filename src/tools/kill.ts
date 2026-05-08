import { setTimeout as delay } from 'node:timers/promises'
import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { zellijCli } from '../zellij/cli.js'
import { unregisterPaneFromWatchdog } from '../zellij/pane-watchdog.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, nextAdvice, publicSession } from './format.js'
import { readOutputSnapshot } from './output.js'

const schema = tool.schema

export function closeFailureMeansGone(message: string): boolean {
  return /not found|no such|does not exist|already closed|already gone|unknown pane/i.test(message)
}

export const zellijPtyKillTool = tool({
  description: 'Terminate a known Zellij PTY session by sending Ctrl-C, then closing its pane.',
  args: {
    id: schema.string().describe('zellij-pty session id.'),
  },
  async execute(args) {
    const session = sessionManager.get(args.id)
    const warnings: string[] = []
    const output = subscriberManager.has(session.id) ? readOutputSnapshot(session.id) : undefined
    try {
      await zellijCli.sendCtrlC(session.paneId)
      await delay(500)
    }
    catch (error) {
      warnings.push(`Ctrl-C failed or pane was already gone: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      await zellijCli.closePane(session.paneId)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`close-pane failed: ${message}`)
      if (!closeFailureMeansGone(message)) {
        const updated = sessionManager.updateStatus(session.id, 'unknown')
        return jsonResponse({
          killed: false,
          cleanedUp: false,
          session: publicSession(updated),
          output,
          next: nextAdvice(true, 'close-pane failed and the pane may still be running; the session was kept so kill can be retried.'),
          warnings,
        })
      }
    }
    subscriberManager.stop(session.id)
    subscriberManager.forget(session.id)
    unregisterPaneFromWatchdog(session.id)
    sessionManager.remove(session.id)
    return jsonResponse({ killed: true, cleanedUp: true, id: session.id, paneId: session.paneId, output, next: nextAdvice(false, 'Session was closed and removed from the in-memory registry.'), warnings })
  },
})
