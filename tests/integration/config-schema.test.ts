import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { formatJsonSchema } from '../../scripts/generate-schema.js'

describe('generated config schema', () => {
  it('matches the committed JSON Schema file', async () => {
    const committed = await readFile('opencode-zellij.schema.json', 'utf8')

    expect(committed).toBe(formatJsonSchema())
  })
})
