import type { PtySession, SessionTerminalReason } from '../pty/session.js'
import process from 'node:process'
import { errorMessage } from '../utils/errors.js'
import { getChildLogger } from '../utils/logger.js'

const logger = getChildLogger('completion-notifications')

async function postPromptAsync(serverUrl: URL, sessionID: string, body: unknown): Promise<Response> {
  const url = new URL(`/session/${encodeURIComponent(sessionID)}/prompt_async`, serverUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const directory = process.env.OPENCODE_DIRECTORY?.trim()
  if (directory)
    headers['x-opencode-directory'] = encodeURIComponent(directory)
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

export interface CompletionNotificationClient {
  session?: {
    prompt?: ((request: any) => Promise<unknown>) | undefined
    promptAsync?: ((request: any) => Promise<unknown>) | undefined
  }
}

export interface CompletionNotificationContext {
  client: CompletionNotificationClient
  serverUrl?: URL | undefined
}

export interface CompletionNotificationManager {
  handleSessionTerminal: (event: SubscriberTerminalEvent) => Promise<void>
  dispose: () => void
}

export interface SubscriberTerminalEvent {
  sessionId: string
  reason: SessionTerminalReason
  session: PtySession
}

export interface CompletionPromptRequest {
  sessionID: string
  parts: Array<{
    type: 'text'
    text: string
  }>
}

function formatExitCode(exitCode: number | null): string {
  return exitCode === null ? '?' : String(exitCode)
}

// Short, system-notification style. Contains the plugin name, pane id, and
// exit code so the agent can immediately call zellij_pty_read on the right
// pane without digging through session metadata.
export function buildCompletionPromptText(event: SubscriberTerminalEvent): string {
  const { paneId, exitCode } = event.session
  return `[zellij_pty] pane ${paneId} exit=${formatExitCode(exitCode)} — call zellij_pty_read to read, then zellij_pty_kill to close.`
}

export function buildCompletionPromptRequest(event: SubscriberTerminalEvent): CompletionPromptRequest {
  return {
    sessionID: event.session.openCodeSessionId!,
    parts: [{ type: 'text', text: buildCompletionPromptText(event) }],
  }
}

export class SessionCompletionNotificationManager implements CompletionNotificationManager {
  private readonly seen = new Set<string>()

  constructor(
    private readonly context: CompletionNotificationContext,
  ) { }

  dispose(): void {
    this.seen.clear()
  }

  async handleSessionTerminal(event: SubscriberTerminalEvent): Promise<void> {
    logger?.withMetadata({
      session: event.sessionId,
      reason: event.reason,
      paneId: event.session.paneId,
      openCodeSessionId: event.session.openCodeSessionId ?? 'null',
    }).info('handleSessionTerminal')
    if (this.seen.has(event.sessionId))
      return
    this.seen.add(event.sessionId)

    if (!event.session.openCodeSessionId) {
      logger?.withMetadata({ session: event.sessionId }).info('skipped: no openCodeSessionId')
      return
    }

    // Try the SDK client first. OpenCode 1.16.x may inject a client whose
    // session is a bare object without a working `_client` field, so fall
    // back to a direct HTTP call to the server's prompt_async endpoint.
    const session = this.context.client.session
    const sdkPrompt = session?.promptAsync ?? session?.prompt
    const request = buildCompletionPromptRequest(event)
    const sessionID = request.sessionID

    if (sdkPrompt) {
      try {
        logger?.withMetadata({ sessionID }).info('SDK prompt attempt')
        await sdkPrompt(request)
        logger?.withMetadata({ sessionID }).info('SDK prompt ok')
        return
      }
      catch (error) {
        logger?.withMetadata({ sessionID, error: errorMessage(error) })
          .warn('SDK prompt failed, falling back to HTTP')
        // fall through to HTTP
      }
    }
    else {
      logger?.withMetadata({
        sessionID,
        sessionKeys: session ? Object.keys(session).join(',') : 'null',
      }).info('no SDK prompt on client, using HTTP fallback')
    }

    if (!this.context.serverUrl) {
      logger?.withMetadata({ sessionID }).error('no serverUrl for HTTP fallback')
      return
    }

    try {
      const response = await postPromptAsync(this.context.serverUrl, sessionID, { parts: request.parts })
      logger?.withMetadata({
        sessionID,
        status: response.status,
        ok: response.ok,
      }).info('HTTP fallback response')
    }
    catch (error) {
      logger?.withMetadata({ sessionID, error: errorMessage(error) })
        .error('HTTP fallback threw')
    }
  }
}
