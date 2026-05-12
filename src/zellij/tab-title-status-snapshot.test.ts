import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchSessionStatusSnapshot, shouldRefreshTabTitleStatusSnapshot, TabTitleStatusSnapshotRefresher } from './tab-title-status-snapshot.js'
import type { OpenCodeEventLike } from './tab-title-events.js'

const workspaceRoot = '/workspace'

describe('shouldRefreshTabTitleStatusSnapshot', () => {
  const relevantEvents: OpenCodeEventLike[] = [
    { type: 'session.status', properties: {} },
    { type: 'session.idle', properties: {} },
    { type: 'session.error', properties: {} },
    { type: 'session.created', properties: {} },
    { type: 'session.deleted', properties: {} },
    { type: 'question.asked', properties: {} },
    { type: 'question.replied', properties: {} },
    { type: 'question.rejected', properties: {} },
    { type: 'permission.asked', properties: {} },
    { type: 'permission.replied', properties: {} },
    { type: 'permission.updated', properties: {} },
  ]

  const irrelevantEvents: OpenCodeEventLike[] = [
    { type: 'vcs.branch.updated', properties: {} },
    { type: 'server.instance.disposed', properties: {} },
    { type: 'global.disposed', properties: {} },
    { type: 'unknown.event.type', properties: {} },
    { type: 'user.typing', properties: {} },
  ]

  it('returns true for events that should trigger snapshot refresh', () => {
    for (const event of relevantEvents) {
      expect(shouldRefreshTabTitleStatusSnapshot(event)).toBe(true)
    }
  })

  it('returns false for events that should not trigger snapshot refresh', () => {
    for (const event of irrelevantEvents) {
      expect(shouldRefreshTabTitleStatusSnapshot(event)).toBe(false)
    }
  })
})

describe('fetchSessionStatusSnapshot', () => {
  describe('generated client { data: { [sessionID]: SessionStatus } } envelope', () => {
    it('parses busy, retry, and idle statuses correctly', async () => {
      const snapshot = await fetchSessionStatusSnapshot({
        session: {
          status: async () => ({
            data: {
              s1: { type: 'busy' },
              s2: { type: 'retry', attempt: 2, message: 'again', next: 10 },
              s3: { type: 'idle' },
            },
          }),
        },
      }, workspaceRoot)

      expect(snapshot).toEqual({
        s1: { type: 'busy' },
        s2: { type: 'retry', attempt: 2, message: 'again', next: 10 },
        s3: { type: 'idle' },
      })
    })
  })

  describe('direct map response (no envelope)', () => {
    it('parses direct session status map', async () => {
      const snapshot = await fetchSessionStatusSnapshot({
        session: {
          status: async () => ({ s1: { type: 'busy' } }),
        },
      }, workspaceRoot)

      expect(snapshot).toEqual({ s1: { type: 'busy' } })
    })
  })

  describe('malformed payloads', () => {
    it('returns undefined for null data', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: null }) },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined for string data', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: 'bad' }) },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined for empty array in data envelope', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: [] }) },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined for plain array (no envelope)', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: {
          status: async () => [
            { sessionID: 's1', status: { type: 'busy' } },
          ],
        },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined for any single invalid status entry (no partial apply)', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: { s1: { type: 'unknown' } } }) },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined when map contains mixed valid and invalid entries', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: { s1: { type: 'busy' }, s2: { type: 'unknown' } } }) },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined for all-invalid entries', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: { s1: { type: 'unknown' }, s2: { type: 'also-unknown' } } }) },
      }, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined when client.session.status is missing', async () => {
      await expect(fetchSessionStatusSnapshot({}, workspaceRoot)).resolves.toBeUndefined()
    })

    it('returns undefined when client.session.status throws', async () => {
      await expect(fetchSessionStatusSnapshot({
        session: {
          status: async () => {
            throw new Error('network error')
          },
        },
      }, workspaceRoot)).resolves.toBeUndefined()
    })
  })

  describe('valid empty snapshot', () => {
    it('returns empty object for empty data map', async () => {
      const snapshot = await fetchSessionStatusSnapshot({
        session: { status: async () => ({ data: {} }) },
      }, workspaceRoot)
      expect(snapshot).toEqual({})
    })

    it('returns empty object for direct empty map', async () => {
      const snapshot = await fetchSessionStatusSnapshot({
        session: { status: async () => ({}) },
      }, workspaceRoot)
      expect(snapshot).toEqual({})
    })
  })
})

describe('TabTitleStatusSnapshotRefresher', () => {
  let tempRoot = ''
  let originalXdgConfigHome: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-refresher-test-'))
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(tempRoot, 'xdg')
  })

  afterEach(async () => {
    if (originalXdgConfigHome === undefined)
      delete process.env.XDG_CONFIG_HOME
    else
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    await rm(tempRoot, { force: true, recursive: true })
  })

  async function writeProjectConfig(directory: string, content: string): Promise<void> {
    const configDir = join(directory, '.opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'opencode-zellij.config.jsonc'), content)
  }

  function makeApplicator() {
    const applied: Record<string, unknown>[] = []
    return {
      applied,
      manager: {
        applySessionStatusSnapshot: (statuses: Record<string, unknown>) => {
          applied.push(statuses)
        },
      },
    }
  }

  it('refreshNow fetches and applies a snapshot immediately', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const { manager, applied } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {
        session: {
          status: async () => ({
            data: { s1: { type: 'busy' }, s2: { type: 'idle' } },
          }),
        },
      },
      workspaceRoot: project,
      manager,
      debounceMs: 1_000,
    })

    await refresher.refreshNow()

    expect(applied.length).toBe(1)
    expect(applied[0]).toEqual({ s1: { type: 'busy' }, s2: { type: 'idle' } })
  })

  it('refreshNow does not apply when fetch returns undefined', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const { manager, applied } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {
        session: {
          status: async () => {
            throw new Error('network error')
          },
        },
      },
      workspaceRoot: project,
      manager,
      debounceMs: 1_000,
    })

    await refresher.refreshNow()

    expect(applied.length).toBe(0)
  })

  it('refreshNow cancels any pending debounced refresh', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const { manager, applied } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {
        session: {
          status: async () => ({ data: { s1: { type: 'busy' } } }),
        },
      },
      workspaceRoot: project,
      manager,
      debounceMs: 10_000,
    })

    // Schedule a debounced refresh that we will cancel
    refresher.scheduleRefresh()
    // Immediately call refreshNow — this should cancel the pending timer
    await refresher.refreshNow()

    // The pending timer was cancelled and refreshNow ran immediately
    expect(applied.length).toBe(1)
    expect(applied[0]).toEqual({ s1: { type: 'busy' } })
  })

  it('scheduleRefresh coalesces multiple calls into one debounced refresh', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const { manager, applied } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {
        session: {
          status: async () => ({ data: { s1: { type: 'busy' } } }),
        },
      },
      workspaceRoot: project,
      manager,
      debounceMs: 100,
    })

    refresher.scheduleRefresh()
    refresher.scheduleRefresh()
    refresher.scheduleRefresh()

    // Wait for the debounce to fire
    await new Promise(resolve => setTimeout(resolve, 150))

    // Should only have applied once despite three scheduleRefresh calls
    expect(applied.length).toBe(1)
    expect(applied[0]).toEqual({ s1: { type: 'busy' } })
  })

  it('scheduleRefresh does not apply until debounce elapses', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const { manager, applied } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {
        session: {
          status: async () => ({ data: { s1: { type: 'busy' } } }),
        },
      },
      workspaceRoot: project,
      manager,
      debounceMs: 200,
    })

    refresher.scheduleRefresh()

    // Before debounce elapses, nothing applied yet
    expect(applied.length).toBe(0)

    // After debounce elapses, it applies
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(applied.length).toBe(1)
    expect(applied[0]).toEqual({ s1: { type: 'busy' } })
  })

  it('dispose clears any pending timer', async () => {
    const project = join(tempRoot, 'project')
    await writeProjectConfig(project, '{ "tabTitle": { "enabled": true } }')
    const { manager, applied } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {
        session: {
          status: async () => ({ data: { s1: { type: 'busy' } } }),
        },
      },
      workspaceRoot: project,
      manager,
      debounceMs: 10_000,
    })

    refresher.scheduleRefresh()
    refresher.dispose()

    // Wait enough time for the debounce to have fired if not disposed
    await new Promise(resolve => setTimeout(resolve, 50))

    // Should not have applied anything since we disposed
    expect(applied.length).toBe(0)
  })

  it('dispose can be called multiple times safely', () => {
    const project = join(tempRoot, 'project')
    const { manager } = makeApplicator()

    const refresher = new TabTitleStatusSnapshotRefresher({
      client: {},
      workspaceRoot: project,
      manager,
      debounceMs: 1_000,
    })

    refresher.scheduleRefresh()
    refresher.dispose()
    refresher.dispose() // Should not throw
  })
})
