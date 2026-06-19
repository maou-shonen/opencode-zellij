import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defaultConfig, sidecarConfigSchema } from '../src/config.js'

const outputPath = resolve('opencode-zellij.schema.json')

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function setDefault(schema: JsonObject, path: string[], value: unknown): void {
  let current = schema
  for (const key of path.slice(0, -1)) {
    current = object(object(current.properties)[key])
  }

  const last = path.at(-1)
  if (!last)
    return

  object(object(current.properties)[last]).default = value
}

export function generateJsonSchema(): JsonObject {
  const schema = z.toJSONSchema(sidecarConfigSchema, {
    target: 'draft-2020-12',
  }) as JsonObject

  schema.$id = 'https://raw.githubusercontent.com/maou-shonen/opencode-zellij/main/opencode-zellij.schema.json'
  schema.title = 'opencode-zellij config'

  setDefault(schema, ['tabTitle', 'enabled'], defaultConfig.tabTitle.enabled)
  setDefault(schema, ['tabTitle', 'emojiIdle'], defaultConfig.tabTitle.emojiIdle)
  setDefault(schema, ['tabTitle', 'emojiRunning'], defaultConfig.tabTitle.emojiRunning)
  setDefault(schema, ['tabTitle', 'emojiNeedsInput'], defaultConfig.tabTitle.emojiNeedsInput)
  setDefault(schema, ['tabTitle', 'debounceMs'], defaultConfig.tabTitle.debounceMs)
  setDefault(schema, ['pty', 'enabled'], defaultConfig.pty.enabled)
  setDefault(schema, ['pty', 'cleanupExitedPaneOnRead'], defaultConfig.pty.cleanupExitedPaneOnRead)
  setDefault(schema, ['pty', 'sudoPane'], defaultConfig.pty.sudoPane)

  return schema
}

export function formatJsonSchema(): string {
  return `${JSON.stringify(generateJsonSchema(), null, 2)}\n`
}

if (import.meta.main) {
  await writeFile(outputPath, formatJsonSchema())
}
