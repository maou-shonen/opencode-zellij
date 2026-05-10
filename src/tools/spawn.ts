import type { Probe } from '../pty/probe.js'
import { tool } from '@opencode-ai/plugin'
import { sessionManager } from '../pty/manager.js'
import { runProbe } from '../pty/probe.js'
import { createExitCodeToken } from '../utils/exit-code.js'
import { createOpenCodePaneTitle } from '../utils/pane-title.js'
import { zellijCli } from '../zellij/cli.js'
import { registerPaneForWatchdog } from '../zellij/pane-watchdog.js'
import { subscriberManager } from '../zellij/subscribe.js'
import { jsonResponse, nextAdvice, publicSession } from './format.js'
import { outputMatches, readOutputSnapshot, validateGrep } from './output.js'

const schema = tool.schema

const probeSchema = schema.discriminatedUnion('type', [
  schema.object({
    type: schema.literal('sleep'),
    seconds: schema.number().positive().max(300).optional().describe('Seconds to wait before returning initial output. Defaults to 1.'),
  }),
  schema.object({
    type: schema.literal('http'),
    url: schema.string().url().describe('HTTP URL to poll until it returns the expected status.'),
    expectStatus: schema.number().int().min(100).max(599).optional().describe('Expected HTTP status. Defaults to any 2xx/3xx response.'),
    timeoutSeconds: schema.number().positive().max(300).optional().describe('How long to poll before returning a failed probe result. Defaults to 20.'),
  }),
  schema.object({
    type: schema.literal('output'),
    grep: schema.string().describe('Regex to search for in observed pane output.'),
    ignoreCase: schema.boolean().optional().describe('Use case-insensitive regex matching.'),
    timeoutSeconds: schema.number().positive().max(300).optional().describe('How long to wait for matching output. Defaults to 20.'),
  }),
])

export const zellijPtySpawnTool = tool({
  description: 'Create a visible Zellij pane and run a command in it.',
  args: {
    command: schema.string().describe('Command to run. Without args, it is executed through bash -lc.'),
    args: schema.array(schema.string()).optional().describe('Optional argv. When provided, command is executed directly without shell parsing.'),
    cwd: schema.string().optional().describe('Working directory for the new pane.'),
    title: schema.string().optional().describe('Pane title/name.'),
    probe: probeSchema.optional().describe('Optional readiness probe. Defaults to a short sleep before returning output.'),
    maxLines: schema.number().int().positive().max(5_000).optional().describe('Maximum recent output lines to return. Defaults to 200.'),
  },
  async execute(args, context) {
    const cwd = args.cwd ?? context.directory
    const exitCodeToken = createExitCodeToken()
    const grepError = args.probe?.type === 'output' ? validateGrep(args.probe.grep) : null
    if (grepError)
      throw new Error(`Invalid probe.grep regex: ${grepError}`)
    const title = createOpenCodePaneTitle(args.title ?? args.command)

    const paneId = await zellijCli.newPane({
      command: args.command,
      args: args.args,
      cwd,
      title,
      floating: false,
      exitCodeToken,
    })

    const session = sessionManager.create({
      openCodeSessionId: context.sessionID,
      paneId,
      title,
      command: args.command,
      args: args.args,
      cwd,
      allowAgentInput: true,
      humanInputOnly: false,
      exitCodeToken,
    })
    registerPaneForWatchdog(session)
    await subscriberManager.start(session)
    const probe = await runProbe(args.probe as Probe | undefined, (grep, ignoreCase) => outputMatches(session.id, grep, ignoreCase))
    const output = readOutputSnapshot(session.id, { maxLines: args.maxLines })

    return jsonResponse({
      session: publicSession(session),
      output,
      probe,
      next: nextAdvice(probe.ok, probe.ok ? 'Probe completed; continue with this session or read later for long-running output.' : probe.message),
      warnings: ['Registry remains in-memory; restarting OpenCode loses plugin session records.'],
    })
  },
})
