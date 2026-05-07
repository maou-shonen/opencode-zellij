import { describe, expect, it } from 'bun:test'
import { buildReviewScript, shellQuote } from './request-sudo.js'

describe('zellij_pty_request_sudo helpers', () => {
  it('shell-quotes single quotes safely', () => {
    expect(shellQuote('it\'s ok')).toBe(`'it'"'"'s ok'`)
  })

  it('builds a human-review script with summary, descriptions, and YES gate', () => {
    const script = buildReviewScript('Install dependency', [
      { command: 'sudo apt-get update', description: 'Refresh package metadata' },
      { command: 'sudo apt-get install -y jq', description: 'Install jq' },
    ])

    expect(script).toContain('=== OpenCode sudo request ===')
    expect(script).toContain('Install dependency')
    expect(script).toContain('Refresh package metadata')
    expect(script).toContain('sudo apt-get install -y jq')
    expect(script).toContain('Type YES to run these commands')
    expect(script).toContain('bash -lc \'sudo apt-get update\'')
  })
})
