import { describe, expect, it } from 'bun:test'
import { createOpenCodePaneTitle } from './pane-title.js'

describe('pane title helpers', () => {
  it('prefixes pane titles with a short OpenCode instance marker', () => {
    expect(createOpenCodePaneTitle('dev server', 'abc12345')).toBe('oc:abc12345:dev server')
  })

  it('does not double-prefix titles that already follow the convention', () => {
    expect(createOpenCodePaneTitle('oc:abc12345:dev server', 'other999')).toBe('oc:abc12345:dev server')
  })

  it('falls back to a generic title for empty input', () => {
    expect(createOpenCodePaneTitle('  ', 'abc12345')).toBe('oc:abc12345:opencode')
  })
})
