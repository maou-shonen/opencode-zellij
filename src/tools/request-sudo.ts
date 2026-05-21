import { tool } from '@opencode-ai/plugin'
import { assertSudoPaneAllowed } from '../permissions/sudo-pane.js'
import { sessionManager } from '../pty/manager.js'
import { createExitCodeToken } from '../utils/exit-code.js'
import { createOpenCodePaneTitle } from '../utils/pane-title.js'
import { zellijCli } from '../zellij/cli.js'
import { registerPaneForWatchdog } from '../zellij/pane-watchdog.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, nextAdvice, publicSession } from './format.js'
import { readOutputSnapshot } from './output.js'

const schema = tool.schema

export function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'"'"'`)}'`
}

export function buildReviewScript(summary: string, scripts: Array<{ command: string, description: string }>): string {
  const lines = [
    'set +e',
    'printf \'%s\\n\' \'=== OpenCode sudo request ===\'',
    `printf '%s\\n' ${shellQuote(summary)}`,
    'printf \'\\n%s\\n\' \'Commands to review:\'',
  ]

  scripts.forEach((script, index) => {
    const number = index + 1
    lines.push(`printf '\\n[%s/%s] %s\\n' ${shellQuote(String(number))} ${shellQuote(String(scripts.length))} ${shellQuote(script.description)}`)
    lines.push(`printf '  $ %s\\n' ${shellQuote(script.command)}`)
  })

  lines.push(
    'printf \'\\n%s\\n\' \'This pane is human-input-only. The agent cannot type here.\'',
    'read -r -p \'Type YES to run these commands, anything else to cancel: \' answer',
    'if [ "$answer" != YES ]; then printf \'%s\\n\' \'Cancelled by user.\'; exit 130; fi',
    'status=0',
  )

  scripts.forEach((script, index) => {
    const number = index + 1
    lines.push(`printf '\\n[%s/%s] %s\\n' ${shellQuote(String(number))} ${shellQuote(String(scripts.length))} ${shellQuote(script.description)}`)
    lines.push(`printf '$ %s\\n' ${shellQuote(script.command)}`)
    lines.push(`bash -lc ${shellQuote(script.command)}`)
    lines.push('code=$?')
    lines.push('if [ $code -ne 0 ]; then status=$code; printf \'Command failed with exit code %s\\n\' "$code"; break; fi')
  })

  lines.push('exit $status')
  return lines.join('\n')
}

export const requestSudoTool = tool({
  description: 'Open a human-reviewed, human-input-only Zellij pane for sudo or other privileged commands.',
  args: {
    summary: schema.string().min(1).describe('TL;DR of why privileged or human-reviewed execution is needed.'),
    scripts: schema
      .array(
        schema.object({
          command: schema.string().min(1).describe('Command or script to run after the user explicitly approves in the pane.'),
          description: schema.string().min(1).describe('Why this command is needed and what it is expected to change.'),
        }),
      )
      .min(1)
      .describe('Commands shown to the user for review before execution.'),
  },
  async execute(args, context) {
    const cwd = context.directory
    const exitCodeToken = createExitCodeToken()
    assertSudoPaneAllowed()

    const command = buildReviewScript(args.summary, args.scripts)
    const title = createOpenCodePaneTitle('zellij_pty_request_sudo')
    const paneId = await zellijCli.newPane({
      command: 'bash',
      args: ['-lc', command],
      cwd,
      title,
      floating: true,
      exitCodeToken,
    })

    const session = sessionManager.create({
      openCodeSessionId: context.sessionID,
      paneId,
      title,
      command: 'zellij_pty_request_sudo',
      args: [],
      cwd,
      allowAgentInput: false,
      humanInputOnly: true,
      exitCodeToken,
    })
    registerPaneForWatchdog(session)
    await subscriberManager.start(session)

    return jsonResponse({
      session: publicSession(session),
      output: readOutputSnapshot(session.id),
      next: nextAdvice(false, 'The user must review the summary and commands in Zellij, then type YES and any required credentials directly in the pane.'),
      warnings: [],
    })
  },
})
