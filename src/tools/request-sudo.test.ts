import { describe, expect, it } from 'bun:test'
import { buildReviewScript, requestSudoTool, shellQuote } from './request-sudo.js'

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

describe('zellij_pty_request_sudo no-focus regression guard', () => {
  it('execute does not call focusPane', () => {
    const source = requestSudoTool.execute.toString()
    expect(source).not.toContain('focusPane')
    expect(source).not.toContain('focus-pane-id')
  })

  it('execute response surfaces humanInputOnly for sudo panes', () => {
    const source = requestSudoTool.execute.toString()
    expect(source).toContain('humanInputOnly')
  })

  it('human-input-only and agent-non-writable semantics are preserved in review script', () => {
    const script = buildReviewScript('test', [
      { command: 'echo ok', description: 'harmless' },
    ])
    expect(script).toContain('This pane is human-input-only. The agent cannot type here.')
    expect(script).toContain('read -r -p \'Type YES to run these commands')
  })
})
