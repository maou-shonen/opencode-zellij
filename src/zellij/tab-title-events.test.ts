import { describe, expect, it } from 'bun:test'
import { deletedSessionID } from './tab-title-events.js'

describe('tab title event helpers', () => {
  it('extracts deleted session id from current and fallback payload shapes', () => {
    expect(deletedSessionID({ type: 'session.deleted', properties: { info: { id: 's1' } } })).toBe('s1')
    expect(deletedSessionID({ type: 'session.deleted', properties: { sessionID: 's2' } })).toBe('s2')
    expect(deletedSessionID({ type: 'session.deleted', properties: {} })).toBeUndefined()
  })
})
