import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { V2ToolDefinition, V2ToolSource } from './v2-tools.js'
import { describe, expect, it } from 'bun:test'
import { tool } from '@opencode-ai/plugin'
import { zellijPtyKillTool } from '../tools/kill.js'
import { zellijPtyListTool } from '../tools/list.js'
import { createZellijPtyReadTool } from '../tools/read.js'
import { createRequestSudoTool } from '../tools/request-sudo.js'
import { zellijPtySpawnTool } from '../tools/spawn.js'
import { zellijPtyWriteTool } from '../tools/write.js'
import { addV2Tool } from './v2-tools.js'

function capture<Args extends V2ToolSource['args']>(name: string, definition: { description: string, args: Args, execute: (args: never, context: ToolContext) => Promise<unknown> }): V2ToolDefinition {
  const added: V2ToolDefinition[] = []
  addV2Tool({
    add(registered) {
      added.push(registered)
    },
  }, name, definition, async () => '/from-resolver')
  const registered = added[0]
  if (!registered)
    throw new Error(`expected ${name} to register`)
  return registered
}

describe('V2 tool registration', () => {
  it('publishes every PTY tool as an object schema', () => {
    const tools = [
      capture('zellij_pty_spawn', zellijPtySpawnTool),
      capture('zellij_pty_list', zellijPtyListTool),
      capture('zellij_pty_write', zellijPtyWriteTool),
      capture('zellij_pty_read', createZellijPtyReadTool({ defaultCleanupExitedPaneOnRead: true })),
      capture('zellij_pty_kill', zellijPtyKillTool),
      capture('zellij_pty_request_sudo', createRequestSudoTool()),
    ]

    expect(tools.map(registered => registered.name)).toEqual([
      'zellij_pty_spawn',
      'zellij_pty_list',
      'zellij_pty_write',
      'zellij_pty_read',
      'zellij_pty_kill',
      'zellij_pty_request_sudo',
    ])
    for (const registered of tools) {
      expect(registered.input.type).toBe('object')
      expect(registered.options).toEqual({ codemode: false })
    }

    const spawn = tools[0]?.input
    const required = spawn?.required
    expect(Array.isArray(required) ? required : []).toContain('command')
    expect(JSON.stringify(spawn?.properties)).toContain('Command to run')
  })

  it('runs the V1 execute function with the resolved directory and returns content', async () => {
    const seen: string[] = []
    const demo = capture('demo', tool({
      description: 'demo',
      args: {
        name: tool.schema.string(),
      },
      async execute(args, context) {
        seen.push(`${args.name}:${context.directory}:${context.sessionID}`)
        return `hello ${args.name}`
      },
    }))

    const result = await demo.execute({ name: 'ada' }, {
      sessionID: 's1',
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ content: 'hello ada' })
    expect(seen).toEqual(['ada:/from-resolver:s1'])
  })
})
