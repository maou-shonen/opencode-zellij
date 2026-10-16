import type { ToolContext } from '@opencode-ai/plugin/tool'
import { tool } from '@opencode-ai/plugin'

const z = tool.schema

export interface V2ToolExecuteContext {
  sessionID: string
  messageID?: string | undefined
  agent?: string | undefined
  signal: AbortSignal
}

export interface V2ToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  options?: { codemode: false } | undefined
  execute: (input: unknown, context: V2ToolExecuteContext) => Promise<{ content: string }>
}

export interface V2ToolEditor {
  add: (tool: V2ToolDefinition) => void
}

export interface V2PluginContext {
  location: {
    directory: string
    project?: { directory?: string | undefined } | undefined
  }
  session: {
    prompt: (input: { sessionID: string, text: string }) => Promise<unknown>
    get?: ((input: { sessionID: string }) => Promise<{ location?: { directory?: string | undefined } | undefined } | undefined>) | undefined
  }
  tool: {
    transform: (callback: (editor: V2ToolEditor) => void) => Promise<unknown>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

export interface ToolArgsShape {
  [key: string]: { parse: (value: unknown) => unknown }
}

export interface V2ToolSource {
  description: string
  args: ToolArgsShape
  execute: (args: never, context: ToolContext) => Promise<unknown>
}

export function jsonSchemaFromArgs(args: ToolArgsShape): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(z.object(args as Parameters<typeof z.object>[0]))
  return schema
}

export function addV2Tool(
  editor: V2ToolEditor,
  name: string,
  definition: V2ToolSource,
  resolveDirectory: (sessionID: string) => Promise<string>,
): void {
  const schema = z.object(definition.args as Parameters<typeof z.object>[0])
  editor.add({
    name,
    description: definition.description,
    input: jsonSchemaFromArgs(definition.args),
    options: { codemode: false },
    async execute(input, context) {
      const args = schema.parse(input)
      const directory = await resolveDirectory(context.sessionID)
      const toolContext = {
        sessionID: context.sessionID,
        messageID: context.messageID ?? '',
        agent: context.agent ?? '',
        directory,
        worktree: directory,
        abort: context.signal,
        metadata() {},
        ask() {
          throw new Error('ask is not available from the V2 tool adapter')
        },
      } satisfies ToolContext
      // The V1 tools parse into their own args shape. V2 hands back
      // host-validated input as unknown, so meet at the boundary.
      const result = await definition.execute(args as never, toolContext)
      if (typeof result === 'string')
        return { content: result }
      if (typeof result === 'object' && result !== null && 'output' in result && typeof result.output === 'string')
        return { content: result.output }
      throw new Error('zellij tool returned an unexpected result')
    },
  })
}
