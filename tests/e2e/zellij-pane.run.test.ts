import { expect, it } from 'bun:test'
import { integration, integrationTimeoutMs } from './support/env.js'
import { context, disposeQuietly, getTool, killQuietly, loadPlugin } from './support/plugin.js'

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
})
