import { setTimeout as delay } from 'node:timers/promises'
import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { assertWriteSizeAllowed, chunkWriteData } from '../pty/write-data.js'
import { errorMessage } from '../utils/errors.js'
import { zellijCli } from '../zellij/cli.js'
import { jsonResponse, publicSession } from './format.js'
import { emptyOutputSnapshot, readOutputSnapshot } from './output.js'

const schema = tool.schema

export const zellijPtyWriteTool = tool({
  description: 'Write stdin to a Zellij PTY session. Throws on human-input-only sessions; agent must not bypass this guard (e.g. via `zellij action write-chars`).',
  args: {
    id: schema.string().describe('zellij-pty session id returned by zellij_pty_spawn or zellij_pty_request_sudo.'),
    data: schema.string().describe('Text to write. Use \u0003 to send Ctrl-C.'),
    maxLines: schema.number().int().positive().max(5_000).optional().describe('Maximum recent output lines to return. Defaults to 200.'),
    interruptAfterSeconds: schema.number().positive().max(300).optional().describe('Blindly send Ctrl-C after this many seconds if the pane is still running; keeps the pane alive.'),
  },
  async execute(args) {
    const session = sessionManager.get(args.id)
    if (session.humanInputOnly || !session.allowAgentInput) {
      // Throw rather than return a warning so the call is unambiguously
      // rejected. The agent can still type into a human-input-only pane by
      // shelling out to `zellij action write-chars` — that path is a
      // conscious bypass, not an accidental "oh the write silently failed".
      throw new Error(
        `zellij_pty_write refused: session ${session.id} (${session.command}) is human-input-only. `
        + `The user owns decisions for this pane. Do not type into it.`,
      )
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
      if (sessionManager.find(session.id)?.status === 'running') {
        await zellijCli.sendCtrlC(session.paneId)
        await delay(500)
      }
    }
    else {
      await delay(1_000)
    }

    const warnings: string[] = []
    let output = emptyOutputSnapshot(session.lineCount)
    try {
      output = readOutputSnapshot(session.id, { maxLines: args.maxLines })
    }
    catch (error) {
      warnings.push(`Session output was unavailable before the write response completed: ${errorMessage(error)}`)
    }

    return jsonResponse({
      session: publicSession(session),
      output,
      warnings,
    })
  },
})
