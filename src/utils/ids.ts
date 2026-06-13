import { randomUUID } from 'node:crypto'

// Match a Zellij terminal pane id (`terminal_<n>`) or a bare numeric id
// (`<n>`), anchored to a whole line. The `m` flag lets the id appear on
// any line of a multi-line payload so a future Zellij change that adds
// a leading debug prefix doesn't immediately break this. Crucially we
// no longer use `\b…\d+\b` with a global match: that would happily pick
// the FIRST number in stdout (e.g. a PID in a debug banner) and map the
// session to the wrong pane, which would then turn the next
// `zellij_pty_kill` into a silent close-wrong-pane.
const paneIdPattern = /^(?:terminal_)?(\d+)\s*$/m

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
