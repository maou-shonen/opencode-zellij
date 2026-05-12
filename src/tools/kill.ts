import { setTimeout as delay } from 'node:timers/promises'
import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { zellijCli } from '../zellij/cli.js'
import { unregisterPaneFromWatchdog } from '../zellij/pane-watchdog.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, nextAdvice, publicSession } from './format.js'
import { readOutputSnapshot } from './output.js'
import { closePaneOrVerifyGone } from './pane-cleanup.js'

const schema = tool.schema

export interface KillToolDependencies {
  zellijCli?: Pick<typeof zellijCli, 'sendCtrlC' | 'closePane' | 'paneExists'> | undefined
}

export interface KillToolResult {
  killed: boolean
  cleanedUp: boolean
  id?: string | undefined
  paneId?: string | undefined
  session?: ReturnType<typeof publicSession> | undefined
  output?: ReturnType<typeof readOutputSnapshot> | undefined
  next: ReturnType<typeof nextAdvice>
  warnings: string[]
}

export async function executeZellijPtyKill(args: { id: string }, dependencies: KillToolDependencies = {}): Promise<KillToolResult> {
  const zellijCliApi = dependencies.zellijCli ?? zellijCli
  const session = sessionManager.get(args.id)
  const warnings: string[] = []
  const output = subscriberManager.has(session.id) ? readOutputSnapshot(session.id) : undefined

  try {
    await zellijCliApi.sendCtrlC(session.paneId)
    await delay(500)
  }
  catch (error) {
    warnings.push(`Ctrl-C failed or pane was already gone: ${error instanceof Error ? error.message : String(error)}`)
  }

  const closeResult = await closePaneOrVerifyGone({
    paneId: session.paneId,
    closePane: () => zellijCliApi.closePane(session.paneId),
    paneExists: zellijCliApi.paneExists,
  })

  if (!closeResult.cleanupReady) {
    warnings.push(`close-pane failed: ${closeResult.closeErrorMessage ?? 'unknown error'}`)
    const updated = sessionManager.updateStatus(session.id, 'unknown')
    return {
      killed: false,
      cleanedUp: false,
      session: publicSession(updated),
      output,
      next: nextAdvice(true, 'close-pane failed and the pane may still be running; the session was kept so kill can be retried.'),
      warnings,
    }
  }

  return finalizeKilledSession(session.id, session.paneId, output, warnings)
}

export const zellijPtyKillTool = tool({
  description: 'Terminate a known Zellij PTY session by sending Ctrl-C, then closing its pane.',
  args: {
    id: schema.string().describe('zellij-pty session id.'),
  },
  async execute(args) {
    return jsonResponse(await executeZellijPtyKill(args))
  },
})

async function finalizeKilledSession(
  sessionId: string,
  paneId: string,
  output: ReturnType<typeof readOutputSnapshot> | undefined,
  warnings: string[],
): Promise<KillToolResult> {
  subscriberManager.stop(sessionId)
  subscriberManager.forget(sessionId)
  unregisterPaneFromWatchdog(sessionId)
  sessionManager.remove(sessionId)
  return {
    killed: true,
    cleanedUp: true,
    id: sessionId,
    paneId,
    output,
    next: nextAdvice(false, 'Session was closed and removed from the in-memory registry.'),
    warnings,
  }
}
