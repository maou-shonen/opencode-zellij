import type { CreateSessionInput, PtySession, SessionStatus } from './session.js'
import { createSessionId } from '../utils/ids.js'

export class SessionManager {
  private readonly sessions = new Map<string, PtySession>()

  create(input: CreateSessionInput): PtySession {
    const now = new Date().toISOString()
    const session: PtySession = {
      id: createSessionId(),
      openCodeSessionId: input.openCodeSessionId ?? null,
      paneId: input.paneId,
      title: input.title,
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      status: 'running',
      lineCount: 0,
      createdAt: now,
      updatedAt: now,
      allowAgentInput: input.allowAgentInput,
      humanInputOnly: input.humanInputOnly,
      exitCode: null,
      exitedAt: null,
      exitCodeToken: input.exitCodeToken ?? null,
    }
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): PtySession {
    const session = this.sessions.get(id)
    if (!session)
      throw new Error(`Unknown zellij PTY session: ${id}`)
    return session
  }

  list(): PtySession[] {
    return Array.from(this.sessions.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  updateLineCount(id: string, lineCount: number): PtySession {
    const session = this.get(id)
    session.lineCount = lineCount
    session.updatedAt = new Date().toISOString()
    return session
  }

  updateStatus(id: string, status: SessionStatus): PtySession {
    const session = this.get(id)
    session.status = status
    session.updatedAt = new Date().toISOString()
    return session
  }

  markExited(id: string, exitCode: number): PtySession {
    const session = this.get(id)
    session.status = 'exited'
    session.exitCode = exitCode
    session.exitedAt = new Date().toISOString()
    session.updatedAt = session.exitedAt
    return session
  }

  listByOpenCodeSession(openCodeSessionId: string): PtySession[] {
    return this.list().filter(session => session.openCodeSessionId === openCodeSessionId)
  }

  remove(id: string): void {
    if (!this.sessions.delete(id))
      throw new Error(`Unknown zellij PTY session: ${id}`)
  }
}

export const sessionManager = new SessionManager()
