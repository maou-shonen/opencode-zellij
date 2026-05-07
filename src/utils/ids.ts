import { randomUUID } from 'node:crypto'

const paneIdPattern = /\b(?:terminal_)?(\d+)\b/

export function createSessionId(): string {
  return `zpty_${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

export function normalizePaneId(rawPaneId: string): string {
  const trimmed = rawPaneId.trim()
  if (/^terminal_\d+$/.test(trimmed))
    return trimmed
  if (/^\d+$/.test(trimmed))
    return `terminal_${trimmed}`
  throw new Error(`Invalid Zellij terminal pane id: ${rawPaneId}`)
}

export function parsePaneId(output: string): string {
  const match = output.match(paneIdPattern)
  if (!match?.[1]) {
    throw new Error(`Unable to parse Zellij pane id from output: ${output.trim() || '<empty>'}`)
  }
  return normalizePaneId(match[1])
}
