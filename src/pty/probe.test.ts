import { describe, expect, it } from 'bun:test'
import { runProbe } from './probe.js'

describe('runProbe', () => {
  it('uses a short sleep probe', async () => {
    const result = await runProbe({ type: 'sleep', seconds: 0.001 }, () => false)

    expect(result.ok).toBe(true)
    expect(result.type).toBe('sleep')
  })

  it('passes when output matches the grep probe', async () => {
    const result = await runProbe({ type: 'output', grep: 'ready', timeoutSeconds: 0.01 }, grep => grep === 'ready')

    expect(result.ok).toBe(true)
    expect(result.type).toBe('output')
  })

  it('returns a failed result when output never matches', async () => {
    const result = await runProbe({ type: 'output', grep: 'missing', timeoutSeconds: 0.01 }, () => false)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Timed out')
  })

  it('passes when an HTTP probe returns the expected status', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('ok', { status: 204 })
      },
    })
    try {
      const result = await runProbe({ type: 'http', url: `http://127.0.0.1:${server.port}`, expectStatus: 204, timeoutSeconds: 1 }, () => false)

      expect(result.ok).toBe(true)
      expect(result.type).toBe('http')
    }
    finally {
      await server.stop(true)
    }
  })
})
