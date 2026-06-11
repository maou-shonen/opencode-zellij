import type { PtySession, SessionTombstone } from '../pty/session.js'

export interface PublicSessionOptions {
  /**
   * Include `tombstone` in the response. Only `read` and `list` need it, because agents
   * observe completed/cleaned-up sessions through those tools. `spawn` / `write` /
   * `request_sudo` should omit it.
   */
  includeTombstone?: boolean | undefined
  /**
   * `true` for agent-writable panes (the default; matches `zellij_pty_spawn`).
   * `false` for human-input-only sudo panes (`zellij_pty_request_sudo`). The
   * non-default value is surfaced to the agent via `humanInputOnly` so it can
   * tell apart "I cannot write here" sessions.
   */
  agentWritable?: boolean | undefined
}

export interface PublicTombstone {
  reason: SessionTombstone['reason']
  terminalAt: string
  tailLines: number
  paneClosedAt: string | null
}

export function publicSession(session: PtySession, options: PublicSessionOptions = {}): Record<string, unknown> {
  const status = session.status === 'terminal' ? 'exited' : session.status
  const summary: Record<string, unknown> = {
    id: session.id,
    paneId: session.paneId,
    title: session.title,
    command: session.command,
    status,
  }

  if (options.agentWritable === false)
    summary.humanInputOnly = true

  if (options.includeTombstone) {
    summary.tombstone = session.tombstone
      ? {
          reason: session.tombstone.reason,
          terminalAt: session.tombstone.terminalAt,
          tailLines: session.tombstone.tail.length,
          paneClosedAt: session.tombstone.paneClosedAt,
        }
      : null
  }

  return summary
}

export function jsonResponse(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
