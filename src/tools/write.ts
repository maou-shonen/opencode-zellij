import { setTimeout as delay } from 'node:timers/promises'
import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { assertWriteSizeAllowed, chunkWriteData } from '../pty/write-data.js'
import { zellijCli } from '../zellij/cli.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, nextAdvice, publicSession } from './format.js'
import { emptyOutputSnapshot, readOutputSnapshot } from './output.js'

const schema = tool.schema

export const zellijPtyWriteTool = tool({
  description: 'Write stdin to a Zellij PTY session. Refuses human-input-only sessions.',
  args: {
    id: schema.string().describe('zellij-pty session id returned by zellij_pty_spawn or request_sudo.'),
    data: schema.string().describe('Text to write. Use \u0003 to send Ctrl-C.'),
    maxLines: schema.number().int().positive().max(5_000).optional().describe('Maximum recent output lines to return. Defaults to 200.'),
    interruptAfterSeconds: schema.number().positive().max(300).optional().describe('Blindly send Ctrl-C after this many seconds if the pane is still running; keeps the pane alive.'),
  },
  async execute(args) {
    const session = sessionManager.get(args.id)
    if (session.humanInputOnly || !session.allowAgentInput) {
      return jsonResponse({
        session: publicSession(session),
        output: subscriberManager.has(session.id) ? readOutputSnapshot(session.id, { maxLines: args.maxLines }) : emptyOutputSnapshot(session.lineCount),
        next: nextAdvice(false, 'This session is human-input-only; the user must type directly in the Zellij pane.'),
        warnings: ['Agent writes to human-input-only sessions are forbidden.'],
      })
    }

    if (args.data === '\u0003' || args.data === '\x03') {
      await zellijCli.sendCtrlC(session.paneId)
    }
    else {
      assertWriteSizeAllowed(args.data)
      for (const chunk of chunkWriteData(args.data)) {
        await zellijCli.writeChars(session.paneId, chunk)
      }
    }

    session.updatedAt = new Date().toISOString()
    if (args.interruptAfterSeconds) {
      await delay(args.interruptAfterSeconds * 1_000)
      if (sessionManager.get(session.id).status === 'running') {
        await zellijCli.sendCtrlC(session.paneId)
        await delay(500)
      }
    }
    else {
      await delay(1_000)
    }

    return jsonResponse({
      session: publicSession(session),
      output: readOutputSnapshot(session.id, { maxLines: args.maxLines }),
      next: nextAdvice(true, args.interruptAfterSeconds ? 'Input was sent; Ctrl-C was sent after the requested interrupt timeout if the session was still running.' : 'Input was sent and recent output was observed.'),
      warnings: [],
    })
  },
})
