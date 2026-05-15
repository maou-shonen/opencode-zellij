import { describe, expect, it } from 'bun:test'
import { canRunIntegration, hasPaneContext, integrationTimeoutMs } from './support/env.js'
import { disposeQuietly, loadPlugin, sendEvent } from './support/plugin.js'
import { currentPaneTabId, currentTabTitle, renameTabById } from './support/zellij.js'
import { waitForTabTitle } from './support/assertions.js'

const tabTitleTui = canRunIntegration && hasPaneContext ? describe : describe.skip

tabTitleTui('real Zellij tab-title TUI integration', () => {
  it('restores tab title after disposed event', async () => {
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

      const restored = await waitForTabTitle((title: string | undefined) => title === uniqueOriginalTitle)
      expect(restored).toBe(true)
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
