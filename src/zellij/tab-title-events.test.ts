import { describe, expect, it } from 'bun:test'
import { deletedSessionID, getInitialBranch, shouldReadInitialBranch } from './tab-title-events.js'

describe('tab title event helpers', () => {
  it('extracts deleted session id from current and fallback payload shapes', () => {
    expect(deletedSessionID({ type: 'session.deleted', properties: { info: { id: 's1' } } })).toBe('s1')
    expect(deletedSessionID({ type: 'session.deleted', properties: { sessionID: 's2' } })).toBe('s2')
    expect(deletedSessionID({ type: 'session.deleted', properties: {} })).toBeUndefined()
  })

  it('reads initial git branch from a branch reader', async () => {
    await expect(getInitialBranch('/repo', async (worktree) => {
      expect(worktree).toBe('/repo')
      return ' main\n'
    })).resolves.toBe('main')
  })

  it('omits initial branch on empty output or branch reader failure', async () => {
    await expect(getInitialBranch('/repo', async () => '\n')).resolves.toBeUndefined()
    await expect(getInitialBranch('/repo', async () => {
      throw new Error('not a git repo')
    })).resolves.toBeUndefined()
  })

  it('only reads initial branch inside a real Zellij pane', () => {
    expect(shouldReadInitialBranch('0')).toBe(true)
    expect(shouldReadInitialBranch(undefined)).toBe(false)
  })
})
