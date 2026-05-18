import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import { integrationTimeoutMs } from './support/env.js'
import { disposeQuietly, loadPlugin, sendEvent } from './support/plugin.js'
import { currentPaneTabId, currentTabTitle, renameTabById } from './support/zellij.js'
import { observeStableTabTitle, waitForTabTitle } from './support/assertions.js'

// Pane-required TUI gating: same three-way logic as zellij-pane.tui.test.ts.
// When RUN_ZELLIJ_E2E=1 is active but Zellij pane context (ZELLIJ,
// ZELLIJ_PANE_ID, ZELLIJ_SESSION_NAME) is absent, fail explicitly instead of
// silently skipping — this enforces the plan's requirement that session-only
// runs no longer produce a clean green for the full E2E entrypoint.
const hasPaneContext = Boolean(
  process.env.ZELLIJ && process.env.ZELLIJ_PANE_ID && process.env.ZELLIJ_SESSION_NAME,
)

if (hasPaneContext) {
  describe('real Zellij tab-title TUI integration', () => {
  it('restores tab title and keeps it stable after disposed event', async () => {
    const originalTabTitle = await currentTabTitle()
    const tabId = await currentPaneTabId()
    expect(tabId).toBeDefined()
    if (tabId === undefined)
      throw new Error('Expected current pane tab id in TUI E2E test')

    const uniqueOriginalTitle = `opencode-zellij-restore-${Date.now()}`
    await renameTabById(tabId, uniqueOriginalTitle)

    const hooks = await loadPlugin()
    expect(hooks.event).toBeDefined()

    try {
      await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'test-session', directory: process.cwd() } } })
      await sendEvent(hooks, {
        type: 'session.status',
        properties: { sessionID: 'test-session', status: { type: 'busy' } },
      })

      const dynamicTitleSeen = await waitForTabTitle(
        (title: string | undefined) => title !== undefined && title !== uniqueOriginalTitle,
      )
      expect(dynamicTitleSeen).toBe(true)

      await sendEvent(hooks, { type: 'server.instance.disposed', properties: {} })

      // Verify the original title is restored AND stays stable for 1s.
      // This catches delayed async rename races that a single-point
      // waitForTabTitle would miss.
      const result = await observeStableTabTitle({
        expected: uniqueOriginalTitle,
        timeoutMs: 8_000,
        stabilityMs: 1_000,
      })
      expect(result.ok).toBe(true)
    }
    finally {
      await disposeQuietly(hooks)
      if (originalTabTitle !== undefined) {
        try {
          await renameTabById(tabId, originalTabTitle)
        }
        catch {
          // best-effort
        }
      }
    }
  }, integrationTimeoutMs)
})
}
else if (process.env.RUN_ZELLIJ_E2E === '1') {
  // Full E2E mode requires pane context; fail explicitly instead of
  // silently skipping the tab-title TUI suite.
  it('E2E tab-title TUI suite requires pane context (ZELLIJ=1 + ZELLIJ_PANE_ID=<id> + ZELLIJ_SESSION_NAME=<session>)', () => {
    throw new Error(
      'Cannot run tab-title TUI tests: missing Zellij pane context.\n'
      + '  Run inside a Zellij pane, or set:\n'
      + '    ZELLIJ=1 ZELLIJ_PANE_ID=<current-pane-id> ZELLIJ_SESSION_NAME=<session>',
    )
  })
}
