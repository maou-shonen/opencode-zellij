import type { PtySession } from '../pty/session.js'

export function publicSession(session: PtySession): Record<string, unknown> {
  return {
    id: session.id,
    paneId: session.paneId,
    title: session.title,
    command: session.command,
    args: session.args,
    cwd: session.cwd,
    status: session.status,
    lineCount: session.lineCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    agentWritable: session.allowAgentInput,
    humanInputOnly: session.humanInputOnly,
    exitCode: session.exitCode,
    exitedAt: session.exitedAt,
  }
}

export interface NextAdvice {
  retryable: boolean
  reason: string
}

export function nextAdvice(retryable: boolean, reason: string): NextAdvice {
  return { retryable, reason }
}

export function jsonResponse(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
