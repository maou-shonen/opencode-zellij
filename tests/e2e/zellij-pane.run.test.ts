import { describe, expect, it } from 'bun:test'
import { createServer } from 'node:net'

import { context, disposeQuietly, getTool, killQuietly, loadPlugin } from './support/plugin.js'
import { withTempGitProject } from './support/temp-project.js'
import { runZellij } from './support/zellij.js'

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, options: { timeoutMs?: number, intervalMs?: number } = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 8_000
  const intervalMs = options.intervalMs ?? 100
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    const value = await read()
    if (predicate(value))
      return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }

  return await read()
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer()

  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve a local TCP port')))
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function listPtySessions(hooks: Awaited<ReturnType<typeof loadPlugin>>, ctx: ReturnType<typeof context>): Promise<{ sessions: Array<Record<string, unknown>>, completedPaneIds: string[], completedPanes: Array<Record<string, unknown>> }> {
  return JSON.parse(await getTool(hooks, 'zellij_pty_list').execute({}, ctx))
}

function listedSession(list: { sessions: Array<Record<string, unknown>> }, sessionID: string): Record<string, unknown> | undefined {
  return list.sessions.find(session => session.id === sessionID)
}

describe('pty tool surface', () => {
  it('loads the built plugin tool surface', async () => {
    const hooks = await loadPlugin()
    try {
      expect(Object.keys(hooks.tool).sort()).toEqual([
        'zellij_pty_kill',
        'zellij_pty_list',
        'zellij_pty_read',
        'zellij_pty_request_sudo',
        'zellij_pty_spawn',
        'zellij_pty_write',
      ])
    }
    finally {
      await disposeQuietly(hooks)
    }
  }, 15_000)
})

describe('zellij_pty_spawn', () => {
  it('spawns a pane, probes output, reads with grep, and kills it', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const spawned = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo integration-ready; sleep 5'],
            probe: { type: 'output', grep: 'integration-ready', timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      )
      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected spawned pane session id')

      expect(spawned.probe.ok).toBe(true)
      expect(spawned.output.text).toContain('integration-ready')

      const read = JSON.parse(await getTool(hooks, 'zellij_pty_read').execute({ id: sessionID, grep: 'integration-ready', maxLines: 50 }, ctx))
      expect(read.output.text).toContain('integration-ready')
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('surfaces already-completed panes in later spawn and list responses', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    const sessionIDs: string[] = []

    try {
      const first = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo completed-pane-hint-ready; exit 0'],
            probe: { type: 'output', grep: 'completed-pane-hint-ready', timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      )
      const firstID = typeof first.session?.id === 'string' ? first.session.id : undefined
      if (!firstID)
        throw new Error('Expected first spawn session id')
      sessionIDs.push(firstID)

      await waitFor(
        async () => listedSession(await listPtySessions(hooks, ctx), firstID)?.status,
        status => status === 'exited',
      )

      const second = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'cat',
            probe: { type: 'sleep', seconds: 0.2 },
            maxLines: 50,
          },
          ctx,
        ),
      )
      const secondID = typeof second.session?.id === 'string' ? second.session.id : undefined
      if (!secondID)
        throw new Error('Expected second spawn session id')
      sessionIDs.push(secondID)

      expect(second.completedPaneIds).toContain(firstID)
      expect(second.completedPanes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: firstID,
            status: 'exited',
            reason: 'exit_marker',
          }),
        ]),
      )
      expect(second.completedPaneIds).not.toContain(secondID)

      const listed = await listPtySessions(hooks, ctx)
      expect(listed.completedPaneIds).toContain(firstID)
      expect(listed.completedPaneIds).not.toContain(secondID)
    }
    finally {
      for (const id of sessionIDs)
        await killQuietly(hooks, id, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('waits for an HTTP probe served by a real spawned pane', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const port = await reserveLocalPort()
      const spawned = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'node',
            args: ['-e', `require("node:http").createServer((_req, res) => { res.writeHead(204); res.end() }).listen(${port}, "127.0.0.1")`],
            probe: { type: 'http', url: `http://127.0.0.1:${port}`, expectStatus: 204, timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      )

      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected spawned pane session id')

      expect(spawned.probe.ok).toBe(true)
      expect(spawned.probe.type).toBe('http')
      expect(spawned.probe.message).toContain(`http://127.0.0.1:${port}`)
      expect(spawned.probe.message).toContain('204')
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('returns output for short-lived commands when no probe is given', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const spawned = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo no-probe-ready'],
            maxLines: 50,
          },
          ctx,
        ),
      )

      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected spawned pane session id')

      expect(spawned.output.text).toContain('no-probe-ready')
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('rejects an invalid probe grep before creating a pane', async () => {
    const hooks = await loadPlugin()
    const ctx = context()

    try {
      await expect(
        getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo should-not-run'],
            probe: { type: 'output', grep: '[', timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      ).rejects.toThrow(/Invalid probe\.grep regex/)
    }
    finally {
      await disposeQuietly(hooks)
    }
  }, 15_000)
})

describe('zellij_pty_write', () => {
  it('writes to an interactive pane and observes output', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const spawned = JSON.parse(await getTool(hooks, 'zellij_pty_spawn').execute({ command: 'cat', probe: { type: 'sleep', seconds: 0.2 }, maxLines: 50 }, ctx))
      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected spawned pane session id')

      const written = JSON.parse(await getTool(hooks, 'zellij_pty_write').execute({ id: sessionID, data: 'integration-write-ok\n', maxLines: 50 }, ctx))
      expect(written.output.text).toContain('integration-write-ok')
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)
})

describe('zellij_pty_kill', () => {
  it('throws when the session is already gone', async () => {
    const hooks = await loadPlugin()
    const ctx = context()

    try {
      await expect(
        getTool(hooks, 'zellij_pty_kill').execute(
          { id: 'zpty_does_not_exist' },
          ctx,
        ),
      ).rejects.toThrow(/Unknown zellij PTY session|zpty_does_not_exist/)
    }
    finally {
      await disposeQuietly(hooks)
    }
  }, 15_000)
})

describe('zellij_pty_read', () => {
  it('keeps externally closed panes terminal without reviving them on read', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined
    let paneId: string | undefined

    try {
      const spawned = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo external-close-ready; sleep 30'],
            probe: { type: 'output', grep: 'external-close-ready', timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      )

      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      paneId = typeof spawned.session?.paneId === 'string' ? spawned.session.paneId : undefined
      expect(sessionID).toBeDefined()
      expect(paneId).toBeDefined()
      if (!sessionID || !paneId)
        throw new Error('Expected spawned pane session id and pane id')
      const activeSessionID = sessionID

      await runZellij(['action', 'close-pane', '--pane-id', paneId])

      const closedSession = await waitFor(
        async () => listedSession(await listPtySessions(hooks, ctx), activeSessionID),
        session => Boolean(
          session
          && session.status === 'exited'
          && typeof session.tombstone === 'object'
          && session.tombstone !== null
          && (session.tombstone as Record<string, unknown>).reason === 'pane_closed'
          && typeof session.subscriber === 'object'
          && session.subscriber !== null
          && (session.subscriber as Record<string, unknown>).active === false
        ),
      )

      expect(closedSession?.status).toBe('exited')
      expect((closedSession?.tombstone as Record<string, unknown> | undefined)?.reason).toBe('pane_closed')

      const read = JSON.parse(
        await getTool(hooks, 'zellij_pty_read').execute(
          { id: sessionID, cleanupExitedPaneOnRead: false, maxLines: 50 },
          ctx,
        ),
      )

      expect(read.session.status).toBe('exited')
      expect(read.session.tombstone?.reason).toBe('pane_closed')
      expect(read.output.text).toContain('external-close-ready')
      expect(read.subscriberActive).toBe(false)
      expect(read.cleanup).toEqual({ requested: false, performed: false, alreadyClosed: false })

      await new Promise(resolve => setTimeout(resolve, 300))

      const listedAfterRead = listedSession(await listPtySessions(hooks, ctx), activeSessionID)
      expect(listedAfterRead?.status).toBe('exited')
      expect((listedAfterRead?.tombstone as Record<string, unknown> | undefined)?.reason).toBe('pane_closed')
      expect(((listedAfterRead?.subscriber as Record<string, unknown> | undefined)?.active)).toBe(false)
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('cleans naturally completed panes on read while preserving exited tombstones', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const spawned = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo cleanup-on-read-ready; sleep 0.2'],
            probe: { type: 'output', grep: 'cleanup-on-read-ready', timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      )

      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected spawned pane session id')
      const activeSessionID = sessionID

      const exitedBeforeCleanup = await waitFor(
        async () => listedSession(await listPtySessions(hooks, ctx), activeSessionID),
        session => Boolean(
          session
          && session.status === 'exited'
          && typeof session.tombstone === 'object'
          && session.tombstone !== null
          && (session.tombstone as Record<string, unknown>).reason === 'exit_marker'
        ),
      )

      expect((exitedBeforeCleanup?.tombstone as Record<string, unknown> | undefined)?.paneClosedAt).toBeNull()

      const firstRead = JSON.parse(
        await getTool(hooks, 'zellij_pty_read').execute(
          { id: sessionID, cleanupExitedPaneOnRead: true, maxLines: 50 },
          ctx,
        ),
      )

      expect(firstRead.session.status).toBe('exited')
      expect(firstRead.session.tombstone?.reason).toBe('exit_marker')
      expect(firstRead.output.text).toContain('cleanup-on-read-ready')
      expect(firstRead.cleanup.requested).toBe(true)
      expect(firstRead.cleanup.performed).toBe(true)

      const listedAfterCleanup = await waitFor(
        async () => listedSession(await listPtySessions(hooks, ctx), activeSessionID),
        session => Boolean(
          session
          && session.status === 'exited'
          && typeof session.tombstone === 'object'
          && session.tombstone !== null
          && (session.tombstone as Record<string, unknown>).reason === 'exit_marker'
          && Boolean((session.tombstone as Record<string, unknown>).paneClosedAt)
        ),
      )

      const paneClosedAt = (listedAfterCleanup?.tombstone as Record<string, unknown> | undefined)?.paneClosedAt
      expect(paneClosedAt).toBeTruthy()

      const secondRead = JSON.parse(
        await getTool(hooks, 'zellij_pty_read').execute(
          { id: sessionID, cleanupExitedPaneOnRead: true, maxLines: 50 },
          ctx,
        ),
      )

      expect(secondRead.session.status).toBe('exited')
      expect(secondRead.session.tombstone?.reason).toBe('exit_marker')
      expect(secondRead.session.tombstone?.paneClosedAt).toBe(paneClosedAt)
      expect(secondRead.cleanup).toEqual({ requested: true, performed: false, alreadyClosed: true })
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('returns a warning for invalid grep regex instead of crashing the read', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const spawned = JSON.parse(
        await getTool(hooks, 'zellij_pty_spawn').execute(
          {
            command: 'bash',
            args: ['-lc', 'echo bad-grep-ready'],
            probe: { type: 'output', grep: 'bad-grep-ready', timeoutSeconds: 5 },
            maxLines: 50,
          },
          ctx,
        ),
      )

      sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected spawned pane session id')
      const activeSessionID = sessionID

      const result = JSON.parse(
        await getTool(hooks, 'zellij_pty_read').execute(
          { id: activeSessionID, grep: '[', maxLines: 50 },
          ctx,
        ),
      )

      expect(result.warnings).toContainEqual(expect.stringContaining('Invalid grep regex'))
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)
})

describe('zellij_pty_request_sudo', () => {
  it('creates zellij_pty_request_sudo as human-only and rejects agent writes', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined

    try {
      const requested = JSON.parse(
        await getTool(hooks, 'zellij_pty_request_sudo').execute(
          {
            summary: 'Harmless integration sudo request smoke.',
            scripts: [{ command: 'echo request-sudo-ok', description: 'Print a harmless marker after user approval.' }],
          },
          ctx,
        ),
      )
      sessionID = typeof requested.session?.id === 'string' ? requested.session.id : undefined
      expect(sessionID).toBeDefined()
      if (!sessionID)
        throw new Error('Expected requested pane session id')

      expect(requested.session.humanInputOnly).toBe(true)
      expect(requested.session.agentWritable).toBeUndefined()

      // Writing to a human-input-only session must throw — silently
      // returning a warning would let the agent think it succeeded.
      await expect(
        getTool(hooks, 'zellij_pty_write').execute({ id: sessionID, data: 'SHOULD_NOT_WRITE\n' }, ctx),
      ).rejects.toThrow(/human-input-only/)
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('renders the summary, the ticking countdown, and the [y/n] prompt in the floating pane', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined
    let paneId: string | undefined

    try {
      const requested = JSON.parse(
        await getTool(hooks, 'zellij_pty_request_sudo').execute(
          {
            summary: 'Countdown rendering smoke.',
            scripts: [{ command: 'echo countdown-rendering-ok', description: 'Verify countdown renders.' }],
          },
          ctx,
        ),
      )
      sessionID = typeof requested.session?.id === 'string' ? requested.session.id : undefined
      paneId = typeof requested.session?.paneId === 'string' ? requested.session.paneId : undefined
      if (!sessionID || !paneId)
        throw new Error('Expected session id and pane id')

      // Dump the rendered pane directly. The subscriber's in-memory buffer
      // dedups Zellij subscribe snapshots imperfectly, so its content does
      // not always reflect the actual visible pane. `dump-screen --full`
      // gives us the current rendered text plus scrollback without that
      // dedup, so we can verify what the user actually sees.
      const dumpPane = () => runZellij(['action', 'dump-screen', '--pane-id', paneId!, '--full'])

      // Wait for the [y/n] prompt to appear in the rendered pane. The
      // script uses \r to overwrite the countdown on a single line, so by
      // the time the prompt is visible only the final "1" tick is left
      // on the countdown line.
      const dump = await waitFor(
        dumpPane,
        text => text.includes('[y/n]:'),
        { timeoutMs: 8_000, intervalMs: 200 },
      )

      // Summary
      expect(dump).toContain('=== OpenCode sudo request ===')
      expect(dump).toContain('Countdown rendering smoke.')
      expect(dump).toContain('Waiting 3s to prevent accidental confirmation')
      // Countdown overwrites the same line, so only the last tick is visible.
      expect(dump).toMatch(/Waiting 3s to prevent accidental confirmation: 1[^2]/)
      // [y/n] prompt — no default, user must type y explicitly to approve.
      expect(dump).toContain('[y/n]:')

      // The prompt must appear after the (final) countdown tick on the
      // rendered pane.
      const idxCountdown = dump.search(/Waiting 3s to prevent accidental confirmation: 1/)
      const idxPrompt = dump.indexOf('[y/n]:')
      expect(idxPrompt).toBeGreaterThan(idxCountdown)
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 15_000)

  it('runs the requested commands when the user types y after the countdown', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined
    let paneId: string | undefined

    try {
      const requested = JSON.parse(
        await getTool(hooks, 'zellij_pty_request_sudo').execute(
          {
            summary: 'YES execution smoke.',
            scripts: [{ command: 'echo yes-flow-ok', description: 'Verify y runs the command.' }],
          },
          ctx,
        ),
      )
      sessionID = typeof requested.session?.id === 'string' ? requested.session.id : undefined
      paneId = typeof requested.session?.paneId === 'string' ? requested.session.paneId : undefined
      if (!sessionID || !paneId)
        throw new Error('Expected requested pane session id and pane id')

      await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_read').execute(
            { id: sessionID, grep: '[y/n]:', maxLines: 50, cleanupExitedPaneOnRead: false },
            ctx,
          ),
        ),
        result => result.output.text.includes('[y/n]:'),
        { timeoutMs: 8_000, intervalMs: 200 },
      )

      // The user must explicitly type `y` — empty Enter cancels. We send
      // `y\n` to drive the approval path; the plugin's `humanInputOnly`
      // guard only blocks writes through the plugin's own `zellij_pty_write`
      // tool, not raw Zellij actions.
      await runZellij(['action', 'write-chars', '--pane-id', paneId, 'y\n'])

      const output = await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_read').execute(
            { id: sessionID, grep: 'yes-flow-ok', maxLines: 50, cleanupExitedPaneOnRead: false },
            ctx,
          ),
        ),
        result => result.output.text.includes('yes-flow-ok'),
        { timeoutMs: 8_000, intervalMs: 200 },
      )
      expect(output.output.text).toContain('yes-flow-ok')
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 20_000)

  it('re-prompts when the user presses empty Enter or types an invalid value', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined
    let paneId: string | undefined

    try {
      const requested = JSON.parse(
        await getTool(hooks, 'zellij_pty_request_sudo').execute(
          {
            summary: 'Strict [y/n] smoke.',
            scripts: [{ command: 'echo should-not-run', description: 'Should never execute.' }],
          },
          ctx,
        ),
      )
      sessionID = typeof requested.session?.id === 'string' ? requested.session.id : undefined
      paneId = typeof requested.session?.paneId === 'string' ? requested.session.paneId : undefined
      if (!sessionID || !paneId)
        throw new Error('Expected session id and pane id')

      // Wait for the prompt to appear.
      await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_read').execute(
            { id: sessionID, grep: '[y/n]:', maxLines: 50, cleanupExitedPaneOnRead: false },
            ctx,
          ),
        ),
        result => result.output.text.includes('[y/n]:'),
        { timeoutMs: 8_000, intervalMs: 200 },
      )

      // First, empty Enter — must re-prompt, not cancel.
      await runZellij(['action', 'write-chars', '--pane-id', paneId, '\n'])

      // The script loops back; verify the re-prompt hint is now in the buffer.
      await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_read').execute(
            { id: sessionID, grep: 'Empty input', maxLines: 50, cleanupExitedPaneOnRead: false },
            ctx,
          ),
        ),
        result => result.output.text.includes('Empty input'),
        { timeoutMs: 5_000, intervalMs: 200 },
      )

      // Second, gibberish input — also must re-prompt.
      await runZellij(['action', 'write-chars', '--pane-id', paneId, 'maybe\n'])

      // Grep for `(got: ` specifically so we don't accidentally match the
      // empty-input re-prompt ("Please type y or n explicitly" is also a
      // substring of the empty-input hint).
      const gibberishRead = await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_read').execute(
            { id: sessionID, grep: '\\(got:', maxLines: 50, cleanupExitedPaneOnRead: false },
            ctx,
          ),
        ),
        result => result.output.text.includes('(got:'),
        { timeoutMs: 5_000, intervalMs: 200 },
      )
      // The re-prompt must include the user's actual input (not the
      // literal `%s` placeholder, which would mean we forgot to interpolate
      // `$answer`).
      expect(gibberishRead.output.text).toContain('(got: maybe)')

      // The session must still be running — neither empty Enter nor
      // invalid input should have terminated the script.
      const sessionList = JSON.parse(
        await getTool(hooks, 'zellij_pty_list').execute({}, ctx),
      )
      const entry = sessionList.sessions.find((e: Record<string, unknown>) => e.id === sessionID)
      expect(entry?.status).toBe('running')

      // Third, a real answer — `n` finally cancels and closes the pane.
      await runZellij(['action', 'write-chars', '--pane-id', paneId, 'n\n'])

      const list = await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_list').execute({}, ctx),
        ),
        (result) => {
          const e = Array.isArray(result.sessions)
            ? result.sessions.find((e: Record<string, unknown>) => e.id === sessionID)
            : undefined
          return Boolean(e && e.status === 'exited' && e.exitCode === 130)
        },
        { timeoutMs: 10_000, intervalMs: 200 },
      )
      expect(list).toBeDefined()
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 30_000)

  it('cancels the request and closes the pane when the user types n', async () => {
    const hooks = await loadPlugin()
    const ctx = context()
    let sessionID: string | undefined
    let paneId: string | undefined

    try {
      const requested = JSON.parse(
        await getTool(hooks, 'zellij_pty_request_sudo').execute(
          {
            summary: 'Cancel flow smoke.',
            scripts: [{ command: 'echo should-not-run', description: 'Should never execute.' }],
          },
          ctx,
        ),
      )
      sessionID = typeof requested.session?.id === 'string' ? requested.session.id : undefined
      paneId = typeof requested.session?.paneId === 'string' ? requested.session.paneId : undefined
      if (!sessionID || !paneId)
        throw new Error('Expected session id and pane id')

      // Wait for the prompt before sending the reject input.
      await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_read').execute(
            { id: sessionID, grep: '[y/n]:', maxLines: 50, cleanupExitedPaneOnRead: false },
            ctx,
          ),
        ),
        result => result.output.text.includes('[y/n]:'),
        { timeoutMs: 8_000, intervalMs: 200 },
      )

      // Send a non-Y answer. With [y/n], anything except Y/y cancels —
      // including `n`, `no`, empty Enter, or stray keys.
      await runZellij(['action', 'write-chars', '--pane-id', paneId, 'n\n'])

      // The script exits 130 after printing "Cancelled by user.". Wait for
      // the session to be marked terminal with that exit code. With
      // --close-on-exit, Zellij also closes the pane immediately, so we
      // verify via the plugin's session list rather than dump-screen.
      const list = await waitFor(
        async () => JSON.parse(
          await getTool(hooks, 'zellij_pty_list').execute({}, ctx),
        ),
        (result) => {
          const entry = Array.isArray(result.sessions)
            ? result.sessions.find((e: Record<string, unknown>) => e.id === sessionID)
            : undefined
          return Boolean(entry && entry.status === 'exited' && entry.exitCode === 130)
        },
        { timeoutMs: 10_000, intervalMs: 200 },
      )
      expect(list).toBeDefined()

      // The pane should also be gone from Zellij's own pane list, because
      // we spawned it with `--close-on-exit`. This is the user-facing
      // behavior: after a cancel, no dead terminal is left behind.
      const panesAfterCancel = await runZellij(['action', 'list-panes', '--json'])
      expect(panesAfterCancel).not.toContain(`"pane_id":${paneId}`)
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, 20_000)
})

describe('pane completion event', () => {
  it('calls client.session.promptAsync when a pane exits so the agent wakes immediately', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const prompts: Array<Record<string, unknown>> = []
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: {
          session: {
            status: async () => ({ data: {} }),
            promptAsync: async (request: Record<string, unknown>) => {
              prompts.push(request)
            },
          },
        },
      })
      const ctx = context()
      ctx.sessionID = 'integration-session'
      let sessionID: string | undefined

      try {
        const spawned = JSON.parse(
          await getTool(hooks, 'zellij_pty_spawn').execute(
            {
              command: 'bash',
              args: ['-lc', 'echo completion-ready; sleep 0.2'],
              cwd: projectRoot,
              probe: { type: 'output', grep: 'completion-ready', timeoutSeconds: 5 },
              maxLines: 50,
            },
            ctx,
          ),
        )
        sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
        if (!sessionID)
          throw new Error('Expected spawned pane session id')
        expect(spawned.probe.ok).toBe(true)

        const settled = await waitFor(
          async () => {
            const list = JSON.parse(await getTool(hooks, 'zellij_pty_list').execute({}, ctx))
            const entry = Array.isArray(list.sessions)
              ? list.sessions.find((e: Record<string, unknown>) => e.id === sessionID)
              : undefined
            return { status: entry?.status, entry }
          },
          ({ status }) => status === 'exited',
        )
        const entry = settled.entry
        expect(entry?.status).toBe('exited')

        // Wait for the prompt to land.
        await waitFor(
          async () => prompts.length,
          (count) => count >= 1,
          { timeoutMs: 5_000 },
        )

        expect(prompts).toHaveLength(1)
        const [prompt] = prompts
        // sessionID on the request must match the OpenCode session that owned the pane.
        const openCodeSessionID = String(entry?.openCodeSessionId ?? '')
        if (openCodeSessionID) {
          expect((prompt as { sessionID?: string }).sessionID).toBe(openCodeSessionID)
        }
        const body = JSON.stringify(prompt)
        expect(body).toContain('[zellij_pty]')
        expect(body).toContain(String(entry?.paneId ?? ''))
        expect(body).toContain('exit=0')
        expect(body).toContain('zellij_pty_read')
        expect(body).toContain('zellij_pty_kill')
      }
      finally {
        if (sessionID)
          await killQuietly(hooks, sessionID, ctx)
        await disposeQuietly(hooks)
      }
    }, { configContent: '{ "tabTitle": { "enabled": true } }' })
  }, 15_000)

  it('falls back to client.session.prompt when promptAsync is unavailable', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const prompts: Array<Record<string, unknown>> = []
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: {
          session: {
            status: async () => ({ data: {} }),
            prompt: async (request: Record<string, unknown>) => {
              prompts.push(request)
              return { data: undefined, error: undefined, request, response: undefined }
            },
          },
        },
      })
      const ctx = context()
      ctx.sessionID = 'session-fallback'
      let sessionID: string | undefined

      try {
        const spawned = JSON.parse(
          await getTool(hooks, 'zellij_pty_spawn').execute(
            {
              command: 'bash',
              args: ['-lc', 'echo fallback-ready; sleep 0.2'],
              cwd: projectRoot,
              probe: { type: 'output', grep: 'fallback-ready', timeoutSeconds: 5 },
              maxLines: 50,
            },
            ctx,
          ),
        )
        sessionID = typeof spawned.session?.id === 'string' ? spawned.session.id : undefined
        if (!sessionID)
          throw new Error('Expected spawned pane session id')

        await waitFor(
          async () => {
            const list = JSON.parse(await getTool(hooks, 'zellij_pty_list').execute({}, ctx))
            const entry = Array.isArray(list.sessions)
              ? list.sessions.find((e: Record<string, unknown>) => e.id === sessionID)
              : undefined
            return { status: entry?.status }
          },
          ({ status }) => status === 'exited',
        )

        await waitFor(
          async () => prompts.length,
          (count) => count >= 1,
          { timeoutMs: 5_000 },
        )

        expect(prompts).toHaveLength(1)
        const body = JSON.stringify(prompts[0])
        expect(body).toContain('[zellij_pty]')
      }
      finally {
        if (sessionID)
          await killQuietly(hooks, sessionID, ctx)
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('does not call client.session.promptAsync when no pane exits', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const prompts: Array<Record<string, unknown>> = []
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: {
          session: {
            status: async () => ({ data: {} }),
            promptAsync: async (request: Record<string, unknown>) => {
              prompts.push(request)
            },
          },
        },
      })
      const ctx = context()
      ctx.sessionID = 'integration-idle'
      try {
        // No spawn, no kill. Wait briefly and assert nothing fired.
        await new Promise(resolve => setTimeout(resolve, 500))
        expect(prompts).toHaveLength(0)
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)
})
