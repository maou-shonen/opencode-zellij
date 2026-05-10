import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SessionManager } from '../pty/manager.js'
import type { ReadLinesInput, ReadLinesResult } from '../pty/ring-buffer.js'
import type { PtySession } from '../pty/session.js'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { sessionManager } from '../pty/manager.js'
import { RingBuffer } from '../pty/ring-buffer.js'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { parseExitCodeMarker } from '../utils/exit-code.js'
import { ensureZellijTarget, zellijCli, zellijCommandArgs } from './cli.js'
import { unregisterPaneFromWatchdog } from './pane-watchdog.js'

interface SubscriberState {
  child: ChildProcessWithoutNullStreams | null
  buffer: RingBuffer
  stderr: string[]
  stdoutRemainder: string
  startedAt: string
  lastExitedAt: string | null
}

type JsonObject = Record<string, unknown>

export interface SubscriberStatus {
  hasBuffer: boolean
  active: boolean
  lastExitedAt: string | null
}

const maxStderrLines = 200

function splitLines(input: string): string[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '')
    return lines.slice(0, -1)
  return lines
}

function textFromCell(cell: unknown): string {
  if (typeof cell === 'string')
    return cell
  if (!cell || typeof cell !== 'object')
    return ''
  const object = cell as JsonObject
  const value = object.text ?? object.character ?? object.ch ?? object.content
  return typeof value === 'string' ? value : ''
}

function linesFromRows(rows: unknown[]): string[] {
  return rows.map((row) => {
    if (typeof row === 'string')
      return row
    if (Array.isArray(row))
      return row.map(textFromCell).join('')
    return textFromCell(row)
  })
}

function eventPaneId(event: JsonObject): string | undefined {
  const paneId = event.pane_id ?? event.paneId
  return typeof paneId === 'string' ? paneId : undefined
}

function eventType(event: JsonObject): string | undefined {
  const type = event.event ?? event.type
  return typeof type === 'string' ? type : undefined
}

function extractRenderedLines(event: JsonObject): string[] {
  for (const key of ['viewport', 'scrollback', 'lines'] as const) {
    const value = event[key]
    if (Array.isArray(value))
      return linesFromRows(value)
  }

  for (const key of ['text', 'output', 'content'] as const) {
    const value = event[key]
    if (typeof value === 'string')
      return splitLines(value)
  }

  return []
}

export class SubscriberManager {
  private readonly subscribers = new Map<string, SubscriberState>()
  // Per-session start promises to prevent concurrent spawn races
  private readonly startingSessions = new Map<string, Promise<void>>()

  constructor(
    private readonly sessions: SessionManager,
    private readonly maxBufferLines = Number(process.env.PTY_MAX_BUFFER_LINES ?? 50_000),
  ) {}

  async start(session: PtySession): Promise<void> {
    const existing = this.subscribers.get(session.id)
    if (existing?.child)
      return

    // Prevent concurrent start races for the same session
    const inProgress = this.startingSessions.get(session.id)
    if (inProgress)
      return inProgress

    ensureZellijTarget()

    const startPromise = this.doStart(session)
    this.startingSessions.set(session.id, startPromise)
    try {
      await startPromise
    }
    finally {
      this.startingSessions.delete(session.id)
    }
  }

  private async doStart(session: PtySession): Promise<void> {
    const existing = this.subscribers.get(session.id)

    const state: SubscriberState
      = existing
        ?? {
          child: null,
          buffer: new RingBuffer(this.maxBufferLines),
          stderr: [],
          stdoutRemainder: '',
          startedAt: new Date().toISOString(),
          lastExitedAt: null,
        }

    if (!existing) {
      this.subscribers.set(session.id, state)
    }

    const child = spawn('zellij', zellijCommandArgs(['subscribe', '--pane-id', session.paneId, '--scrollback', '--format', 'json', '--ansi']), {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end()
    // Only assign child if state is still the same (no concurrent restart)
    const currentState = this.subscribers.get(session.id)
    if (currentState !== state) {
      child.kill('SIGTERM')
      return
    }
    state.child = child
    state.lastExitedAt = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.handleStdout(session.id, child, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.handleStderr(session.id, child, chunk))
    child.on('exit', () => this.handleSubscriberExit(session.id, child))
    child.on('error', error => this.handleSubscriberError(session.id, child, error))

    if (!existing) {
      try {
        const snapshot = await zellijCli.dumpScreen(session.paneId)
        if (this.subscribers.get(session.id) !== state || state.child !== child)
          return
        state.buffer.appendSnapshot(snapshot)
        this.sessions.updateLineCount(session.id, state.buffer.lineCount)
      }
      catch (error) {
        // dump-screen may race with pane creation; subscribe will still collect future output.
        debug('dumpScreen failed', errorMessage(error))
      }
    }
  }

  read(sessionId: string, input: ReadLinesInput): ReadLinesResult {
    const state = this.subscribers.get(sessionId)
    if (!state)
      throw new Error(`No subscriber buffer exists for session: ${sessionId}`)
    return state.buffer.read(input)
  }

  has(sessionId: string): boolean {
    return this.subscribers.has(sessionId)
  }

  status(sessionId: string): SubscriberStatus {
    const state = this.subscribers.get(sessionId)
    return {
      hasBuffer: Boolean(state),
      active: Boolean(state?.child),
      lastExitedAt: state?.lastExitedAt ?? null,
    }
  }

  stderr(sessionId: string): string[] {
    return this.subscribers.get(sessionId)?.stderr ?? []
  }

  stop(sessionId: string): void {
    const state = this.subscribers.get(sessionId)
    if (!state)
      return
    state.child?.kill('SIGTERM')
    state.child = null
    state.lastExitedAt = new Date().toISOString()
  }

  forget(sessionId: string): void {
    this.stop(sessionId)
    this.subscribers.delete(sessionId)
  }

  stopAll(): void {
    for (const sessionId of this.subscribers.keys()) {
      this.forget(sessionId)
    }
  }

  async closeSessionPane(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    this.stop(sessionId)
    try {
      await zellijCli.closePane(session.paneId)
    }
    catch (error) {
      // Pane may already be closed by the user or command exit.
      debug('closePane failed', errorMessage(error))
    }
  }

  private handleStdout(sessionId: string, child: ChildProcessWithoutNullStreams, chunk: string): void {
    const state = this.subscribers.get(sessionId)
    if (!state || state.child !== child)
      return

    const parts = `${state.stdoutRemainder}${chunk}`.split('\n')
    state.stdoutRemainder = parts.pop() ?? ''
    for (const part of parts) {
      this.handleJsonLine(sessionId, child, part)
    }
  }

  private handleJsonLine(sessionId: string, child: ChildProcessWithoutNullStreams, line: string): void {
    const state = this.subscribers.get(sessionId)
    if (!state || state.child !== child)
      return
    const trimmed = line.trim()
    if (!trimmed)
      return

    let event: JsonObject
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object')
        return
      event = parsed as JsonObject
    }
    catch (error) {
      state.buffer.append(trimmed)
      this.sessions.updateLineCount(sessionId, state.buffer.lineCount)
      debug('JSON parse of subscriber event failed, treating as raw text', errorMessage(error))
      return
    }

    let session: PtySession
    try {
      session = this.sessions.get(sessionId)
    }
    catch (error) {
      this.forget(sessionId)
      debug('session lookup by id failed', errorMessage(error))
      return
    }
    const paneId = eventPaneId(event)
    if (paneId && paneId !== session.paneId)
      return

    const type = eventType(event)
    if (type === 'pane_closed' || type === 'PaneClosed') {
      state.buffer.append(`[zellij-pty] Pane ${session.paneId} closed at ${new Date().toISOString()}`)
      this.sessions.updateLineCount(sessionId, state.buffer.lineCount)
      this.sessions.updateStatus(sessionId, session.status === 'killed' ? 'killed' : 'exited')
      unregisterPaneFromWatchdog(sessionId)
      this.stop(sessionId)
      return
    }

    const lines = extractRenderedLines(event)
    if (lines.length === 0)
      return
    state.buffer.appendSnapshot(lines)
    this.captureExitCode(sessionId, lines)
    this.sessions.updateLineCount(sessionId, state.buffer.lineCount)
  }

  private captureExitCode(sessionId: string, lines: string[]): void {
    const session = this.sessions.get(sessionId)
    if (!session.exitCodeToken)
      return

    for (const line of lines) {
      const marker = parseExitCodeMarker(line)
      if (!marker || marker.token !== session.exitCodeToken)
        continue
      this.sessions.markExited(sessionId, marker.exitCode)
      return
    }
  }

  private handleStderr(sessionId: string, child: ChildProcessWithoutNullStreams, chunk: string): void {
    const state = this.subscribers.get(sessionId)
    if (!state || state.child !== child)
      return
    state.stderr.push(...splitLines(chunk))
    if (state.stderr.length > maxStderrLines) {
      state.stderr = state.stderr.slice(state.stderr.length - maxStderrLines)
    }
  }

  private handleSubscriberExit(sessionId: string, child: ChildProcessWithoutNullStreams): void {
    const state = this.subscribers.get(sessionId)
    if (!state)
      return
    if (state.child !== child)
      return
    state.child = null
    state.lastExitedAt = new Date().toISOString()
    state.stderr.push(`[zellij-pty] subscriber exited at ${state.lastExitedAt}; last buffered output is retained.`)
    if (state.stderr.length > maxStderrLines) {
      state.stderr = state.stderr.slice(state.stderr.length - maxStderrLines)
    }
  }

  private handleSubscriberError(sessionId: string, child: ChildProcessWithoutNullStreams, error: Error): void {
    const state = this.subscribers.get(sessionId)
    if (state?.child === child) {
      state.stderr.push(error.message)
      state.child = null
      state.lastExitedAt = new Date().toISOString()
      this.sessions.updateStatus(sessionId, 'unknown')
    }
  }
}

export const subscriberManager = new SubscriberManager(sessionManager)
