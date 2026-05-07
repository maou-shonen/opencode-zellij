import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, nextAdvice, publicSession } from './format.js'
import { readOutputSnapshot, validateGrep } from './output.js'

const schema = tool.schema

export const zellijPtyReadTool = tool({
  description: 'Read recent rendered output from a Zellij PTY session. Supports regex grep filtering.',
  args: {
    id: schema.string().describe('zellij-pty session id.'),
    maxLines: schema.number().int().positive().max(5_000).optional().describe('Maximum recent output lines to return. Defaults to 200.'),
    grep: schema.string().optional().describe('Regex used to filter returned lines.'),
    ignoreCase: schema.boolean().optional().describe('Use case-insensitive regex matching.'),
  },
  async execute(args) {
    const session = sessionManager.get(args.id)
    const grepError = validateGrep(args.grep)
    if (grepError) {
      return jsonResponse({
        session: publicSession(session),
        output: { text: '', lines: [], lineCount: session.lineCount, returned: 0, truncated: false },
        next: nextAdvice(false, `Invalid grep regex: ${grepError}`),
        warnings: [],
      })
    }

    if (!subscriberManager.has(session.id)) {
      await subscriberManager.start(session)
    }
    const subscriberStatus = subscriberManager.status(session.id)
    const warnings: string[] = []
    if (session.humanInputOnly) {
      warnings.push('This pane is human-input-only: agent writes are forbidden, but rendered output is visible to the agent.')
    }
    if (!subscriberStatus.active) {
      warnings.push('Subscriber is inactive; returned output may be stale.')
      if (session.status === 'running') {
        sessionManager.updateStatus(session.id, 'unknown')
      }
    }

    const output = readOutputSnapshot(session.id, { maxLines: args.maxLines, grep: args.grep, ignoreCase: args.ignoreCase })

    return jsonResponse({
      session: publicSession(session),
      output,
      next: nextAdvice(session.status !== 'exited' && session.status !== 'killed', nextReadReason(session.status)),
      subscriberActive: subscriberStatus.active,
      subscriberLastExitedAt: subscriberStatus.lastExitedAt,
      subscriberErrors: subscriberManager.stderr(session.id),
      warnings,
    })
  },
})

function nextReadReason(status: string): string {
  if (status === 'running')
    return 'Session is still running; read again later if more output is expected.'
  if (status === 'unknown')
    return 'Session state is unknown because the subscriber is inactive; output may be stale, but retrying read may restart observation.'
  return 'Session is no longer running.'
}
