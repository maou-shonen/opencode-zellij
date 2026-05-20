import { expect, it } from 'bun:test'
import { createServer } from 'node:net'
import { integration, integrationTimeoutMs } from './support/env.js'
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

async function listPtySessions(hooks: Awaited<ReturnType<typeof loadPlugin>>, ctx: ReturnType<typeof context>): Promise<{ sessions: Array<Record<string, unknown>> }> {
  return JSON.parse(await getTool(hooks, 'zellij_pty_list').execute({}, ctx))
}

function listedSession(list: { sessions: Array<Record<string, unknown>> }, sessionID: string): Record<string, unknown> | undefined {
  return list.sessions.find(session => session.id === sessionID)
}

integration('real Zellij pane run integration', () => {
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
  }, integrationTimeoutMs)

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
  }, integrationTimeoutMs)

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
  }, integrationTimeoutMs)

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
  }, integrationTimeoutMs)

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
  }, integrationTimeoutMs)

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
  }, integrationTimeoutMs)

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
      expect(requested.session.agentWritable).toBe(false)

      const write = JSON.parse(await getTool(hooks, 'zellij_pty_write').execute({ id: sessionID, data: 'SHOULD_NOT_WRITE\n' }, ctx))
      expect(write.next.retryable).toBe(false)
      expect(write.warnings.join('\n')).toContain('forbidden')
    }
    finally {
      if (sessionID)
        await killQuietly(hooks, sessionID, ctx)
      await disposeQuietly(hooks)
    }
  }, integrationTimeoutMs)

  it('delivers active completion prompts for short-lived panes without queueing duplicate chat notices', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const prompts: Array<Record<string, unknown>> = []
      const toasts: Array<Record<string, unknown>> = []
      const client = {
        session: {
          status: async () => ({ data: { 'integration-session': { type: 'idle' } } }),
          prompt: async (request: Record<string, unknown>) => {
            prompts.push(request)
          },
        },
        tui: {
          showToast: async (payload: Record<string, unknown>) => {
            toasts.push(payload)
          },
        },
      }
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client,
      }) as Awaited<ReturnType<typeof loadPlugin>> & {
        'chat.message'?: (input: { sessionID: string }, output: { message: unknown, parts: Array<{ type: string, text?: string }> }) => Promise<void>
      }
      const ctx = context()
      ctx.sessionID = 'integration-session'
      let sessionID: string | undefined

      try {
        const spawned = JSON.parse(
          await getTool(hooks, 'zellij_pty_spawn').execute(
            {
              command: 'bash',
              args: ['-lc', 'echo prompt-delivery-ready; sleep 0.2'],
              cwd: projectRoot,
              probe: { type: 'output', grep: 'prompt-delivery-ready', timeoutSeconds: 5 },
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

        const settled = await waitFor(
          async () => ({
            list: JSON.parse(await getTool(hooks, 'zellij_pty_list').execute({}, ctx)),
            promptCount: prompts.length,
          }),
          ({ list, promptCount }) => {
            const session = Array.isArray(list.sessions)
              ? list.sessions.find((entry: Record<string, unknown>) => entry.id === sessionID)
              : undefined
            return promptCount === 1 && session?.status === 'exited'
          },
        )

        const listedSession = settled.list.sessions.find((entry: Record<string, unknown>) => entry.id === sessionID)
        expect(listedSession).toBeDefined()
        expect(listedSession?.status).toBe('exited')
        expect(prompts).toHaveLength(1)
        expect(toasts).toHaveLength(1)
        expect(prompts[0]).toEqual({
          path: { id: 'integration-session' },
          body: {
            parts: [{ type: 'text', text: 'A Zellij PTY session completed. Review the finished pane if needed.' }],
          },
        })

        const output = {
          message: { role: 'user', content: 'hello' },
          parts: [{ type: 'text', text: 'hello' }],
        }

        await hooks['chat.message']?.({ sessionID: 'integration-session' }, output)

        expect(output.parts).toEqual([{ type: 'text', text: 'hello' }])
        expect(prompts).toHaveLength(1)
      }
      finally {
        if (sessionID)
          await killQuietly(hooks, sessionID, ctx)
        await disposeQuietly(hooks)
      }
    }, { configContent: '{ "tabTitle": { "enabled": true }, "pty": { "completionNotification": { "mode": "queue+toast", "prompt": { "requireIdle": true, "cooldownMs": 30000, "maxAttempts": 1 } } }, "autoUpdate": false }' })
  }, integrationTimeoutMs)
})
