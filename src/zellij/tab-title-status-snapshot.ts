import type { SessionStatus as OpenCodeSessionStatus } from '@opencode-ai/sdk'
import type { OpenCodeEventLike } from './tab-title-events.js'
import { debug } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'

/**
 * Client surface required to fetch session status snapshots.
 *
 * The generated OpenCode client exposes `session.status()` which returns a
 * wrapped envelope `{ data: { [sessionID]: SessionStatus } }`.  Direct map
 * responses are also accepted for test / mock environments.
 */
export interface SessionStatusSnapshotClient {
  session?: {
    status?: (options: { query: { directory: string } }) => Promise<unknown>
  }
}

/**
 * Events that should trigger a debounced refresh of the tab title base status
 * via the `/session/status` snapshot API.
 *
 * Base state (running vs idle) is sourced from the snapshot rather than
 * individual `session.idle` events because testing showed that both parent and
 * child sessions report busy during subagent execution, and the parent remains
 * busy even after the child completes.  The snapshot gives a consistent,
 * server-authoritative view.  `needs-input` has no REST API, so it continues
 * to be managed purely through events.
 *
 * The snapshot reconciliation is intentionally *not* optimistic for idle-like
 * transitions: a lone parent/child idle event can be stale during subagent
 * handoff.  The debounce coalesces high-frequency event streams to avoid
 * hammering the API on every individual status change.
 */
export function shouldRefreshTabTitleStatusSnapshot(event: OpenCodeEventLike): boolean {
  switch (event.type) {
    case 'session.status':
    case 'session.idle':
    case 'session.error':
    case 'session.created':
    case 'session.deleted':
    case 'question.asked':
    case 'question.replied':
    case 'question.rejected':
    case 'permission.asked':
    case 'permission.replied':
    case 'permission.updated':
      return true
    default:
      return false
  }
}

/**
 * Best-effort fetch of session statuses for a workspace.
 *
 * Only accepts object-keyed maps: `{ [sessionID]: SessionStatus }` directly,
 * or the generated-client envelope `{ data: { [sessionID]: SessionStatus } }`.
 *
 * An empty map `{}` is a valid snapshot (all sessions ended / none tracked).
 * Arrays are never accepted — they always return undefined.
 * If any single status entry fails to parse, the entire snapshot is rejected
 * (no partial apply) to avoid incorrectly clearing session states.
 *
 * Failures are swallowed and return undefined so the caller never throws.
 */
export async function fetchSessionStatusSnapshot(
  client: SessionStatusSnapshotClient,
  workspaceRoot: string,
): Promise<Record<string, OpenCodeSessionStatus> | undefined> {
  try {
    if (!client.session?.status) {
      debug('fetchSessionStatusSnapshot: client.session.status not available')
      return undefined
    }

    const result = await client.session.status({ query: { directory: workspaceRoot } })
    const payload = result && typeof result === 'object' && 'data' in result
      ? (result as { data: unknown }).data
      : result

    // Only object-keyed maps are accepted.  Arrays, null, and primitives are rejected.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      debug('fetchSessionStatusSnapshot received non-object payload')
      return undefined
    }

    // Collect all entries and validate every one before applying.
    // Partial snapshots are rejected to avoid incorrectly clearing session states.
    const entries = Object.entries(payload)
    if (entries.length === 0)
      return {}

    const snapshot: Record<string, OpenCodeSessionStatus> = {}
    for (const [sessionID, status] of entries) {
      const parsed = parseSessionStatus(status)
      if (parsed === undefined) {
        debug('fetchSessionStatusSnapshot received invalid status entry, rejecting entire snapshot')
        return undefined
      }
      snapshot[sessionID] = parsed
    }

    return snapshot
  }
  catch (err) {
    debug('fetchSessionStatusSnapshot failed', errorMessage(err))
    return undefined
  }
}

function parseSessionStatus(value: unknown): OpenCodeSessionStatus | undefined {
  if (!value || typeof value !== 'object' || !('type' in value))
    return undefined

  const status = value as Record<string, unknown>
  if (status.type === 'idle' || status.type === 'busy')
    return { type: status.type }

  if (status.type === 'retry') {
    return {
      type: 'retry',
      attempt: typeof status.attempt === 'number' ? status.attempt : 0,
      message: typeof status.message === 'string' ? status.message : '',
      next: typeof status.next === 'number' ? status.next : 0,
    }
  }

  return undefined
}

/**
 * Minimal interface for the portion of TabTitleManager used by the refresher.
 * This avoids a hard dependency on the full TabTitleManager class.
 */
export interface TabTitleSnapshotApplicator {
  applySessionStatusSnapshot: (statuses: Record<string, OpenCodeSessionStatus>) => void
}

const DEFAULT_DEBOUNCE_MS = 1_000

/**
 * Encapsulates tab title session-status snapshot fetching with debounced refresh.
 *
 * This class replaces the nested `refreshTabTitleSnapshot` /
 * `scheduleTabTitleSnapshotRefresh` functions that previously lived inside
 * `createZellijPtyPlugin`.  It manages its own timer so the plugin factory
 * remains a simple composition root.
 *
 * Usage:
 * ```
 * const refresher = tabTitleManager
 *   ? new TabTitleStatusSnapshotRefresher({ client, workspaceRoot, manager: tabTitleManager })
 *   : undefined
 *
 * await refresher?.refreshNow()          // initial snapshot
 * refresher?.scheduleRefresh()           // on relevant events
 * refresher?.dispose()                   // on shutdown
 * ```
 */
export class TabTitleStatusSnapshotRefresher {
  private readonly client: SessionStatusSnapshotClient
  private readonly workspaceRoot: string
  private readonly manager: TabTitleSnapshotApplicator
  private readonly debounceMs: number
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: {
    client: SessionStatusSnapshotClient
    workspaceRoot: string
    manager: TabTitleSnapshotApplicator
    debounceMs?: number
  }) {
    this.client = options.client
    this.workspaceRoot = options.workspaceRoot
    this.manager = options.manager
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  /**
   * Fetches and applies the snapshot immediately, cancelling any pending
   * debounced refresh.
   */
  async refreshNow(): Promise<void> {
    this.clearTimer()
    const snapshot = await fetchSessionStatusSnapshot(this.client, this.workspaceRoot)
    if (snapshot !== undefined)
      this.manager.applySessionStatusSnapshot(snapshot)
  }

  /**
   * Schedules a debounced snapshot refresh.  Subsequent calls while a timer
   * is pending coalesce into a single refresh.
   */
  scheduleRefresh(): void {
    if (this.timer)
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.refreshNow().catch(err => debug('tab title snapshot refresh failed', errorMessage(err)))
    }, this.debounceMs)
  }

  /**
   * Clears any pending debounced refresh.  Use this during shutdown so a
   * pending timer does not fire after the manager has been destroyed.
   */
  dispose(): void {
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
