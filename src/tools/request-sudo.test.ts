import { describe, expect, it } from 'bun:test'
import { buildPaneTitle, buildReviewScript, createRequestSudoTool, requestSudoTool, shellQuote } from './request-sudo.js'

describe('zellij_pty_request_sudo helpers', () => {
  it('shell-quotes single quotes safely', () => {
    expect(shellQuote('it\'s ok')).toBe(`'it'"'"'s ok'`)
  })

  it('builds a human-review script with summary, descriptions, [y/n] gate, and executable command', () => {
    const script = buildReviewScript('Install dependency', [
      { command: 'sudo apt-get update', description: 'Refresh package metadata' },
      { command: 'sudo apt-get install -y jq', description: 'Install jq' },
    ])

    expect(script).toContain('=== OpenCode sudo request ===')
    expect(script).toContain('Install dependency')
    expect(script).toContain('Refresh package metadata')
    expect(script).toContain('sudo apt-get install -y jq')
    expect(script).toContain('Waiting 3s to prevent accidental confirmation')
    expect(script).toContain('[y/n]:')
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
})

describe('zellij_pty_request_sudo accidental-confirmation guard', () => {
  it('human-input-only and agent-non-writable semantics are preserved in review script', () => {
    const script = buildReviewScript('test', [
      { command: 'echo ok', description: 'harmless' },
    ])
    expect(script).toContain('This pane is human-input-only. The agent cannot type here.')
    expect(script).toContain('read -r answer')
  })

  it('loops the prompt until the user types y, Y, n, or N — empty Enter and stray input re-prompt', () => {
    const script = buildReviewScript('test', [
      { command: 'echo ok', description: 'harmless' },
    ])
    // The script must wrap the read+case in a `while true` loop and break
    // out on `y`/`Y`. Empty input (`""`) and any other input re-prompts;
    // only `n`/`N` cancels and exits 130.
    expect(script).toContain('while true; do')
    expect(script).toContain('[Yy]) break')
    expect(script).toContain('[Nn]) printf \'%s\\n\' \'Cancelled by user.\'; exit 130')
    expect(script).toContain('Empty input. Please type y or n explicitly.')
    // The re-prompt for invalid input must interpolate `$answer` so the user
    // sees what they typed — not the literal `%s` placeholder.
    expect(script).toContain('Please type y or n (got: $answer)')
  })

  it('emits a 3s countdown that overwrites the same line as it ticks down', () => {
    const script = buildReviewScript('test', [
      { command: 'echo ok', description: 'harmless' },
    ])
    // Each countdown tick uses \r to overwrite the previous number on the
    // same line, so we only see one number at a time (3 → 2 → 1). The
    // escape `\r` in the JS source becomes `\r` in the script.
    const waitIdx = script.indexOf('Waiting 3s to prevent accidental confirmation: 3\\r')
    const twoIdx = script.indexOf('Waiting 3s to prevent accidental confirmation: 2\\r')
    const oneIdx = script.indexOf('Waiting 3s to prevent accidental confirmation: 1\\r')
    const promptIdx = script.indexOf('[y/n]:')

    expect(waitIdx).toBeGreaterThan(-1)
    expect(twoIdx).toBeGreaterThan(waitIdx)
    expect(oneIdx).toBeGreaterThan(twoIdx)
    expect(promptIdx).toBeGreaterThan(oneIdx)

    // The countdown must not stack three separate lines like the old style.
    expect(script).not.toContain("printf '%s\\n' 3\\nsleep 1\\nprintf '%s\\n' 2\\nsleep 1\\nprintf '%s\\n' 1")
  })

  it('uses plain read instead of read -p so the prompt can follow the countdown', () => {
    const script = buildReviewScript('test', [
      { command: 'echo ok', description: 'harmless' },
    ])
    expect(script).not.toContain('read -r -p')
  })
})

describe('zellij_pty_request_sudo pane presentation', () => {
  it('default factory forwards floating size options to newPane', () => {
    const source = requestSudoTool.execute.toString()
    // The minified body uses `floating: isFloating` and forwards the size
    // fields from `options.floatingSize`. We just verify the wiring is
    // present, not the literal `floating: true`.
    expect(source).toContain('floatingWidth')
    expect(source).toContain('floatingHeight')
    expect(source).toContain('floatingPinned')
    expect(source).toContain('options.floatingSize')
    // No `--near-current-pane` for floating (CLI strips it)
    expect(source).not.toContain('--near-current-pane')
  })

  it('default factory passes closeOnExit=true so the pane closes after the script finishes', () => {
    const source = requestSudoTool.execute.toString()
    expect(source).toContain('closeOnExit')
  })

  it('builds a descriptive title via the buildPaneTitle helper', () => {
    expect(buildPaneTitle('Install build dependency'))
      .toBe('⚠ sudo: Install build dependency')
  })

  it('clamps long summaries in the pane title', () => {
    const longSummary = 'x'.repeat(80)
    const title = buildPaneTitle(longSummary)
    expect(title.startsWith('⚠ sudo: ')).toBe(true)
    expect(title.length).toBeLessThanOrEqual('⚠ sudo: '.length + 60)
    expect(title.endsWith('...')).toBe(true)
  })

  it('collapses internal whitespace in the pane title', () => {
    expect(buildPaneTitle('  hello   world  ')).toBe('⚠ sudo: hello world')
  })
})
