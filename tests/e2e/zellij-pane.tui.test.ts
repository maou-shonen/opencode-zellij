import { describe, expect, it } from 'bun:test'
import process from 'node:process'
import { integrationTimeoutMs } from './support/env.js'
import { verifySpawnedTerminalPaneIdentity } from './support/spawned-pane.js'
import { currentPaneTabId, listPanes, runZellij, zellijID } from './support/zellij.js'

// Pane-required TUI gating: the test body requires ZELLIJ, ZELLIJ_PANE_ID,
// AND ZELLIJ_SESSION_NAME (to target the right session for CLI actions).
// When RUN_ZELLIJ_E2E=1 is active but pane context is absent, fail explicitly
// instead of silently skipping — the plan calls this out as a non-goal.
const hasPaneContext = Boolean(
  process.env.ZELLIJ && process.env.ZELLIJ_PANE_ID && process.env.ZELLIJ_SESSION_NAME,
)

if (hasPaneContext) {
  describe('real Zellij pane TUI integration', () => {
    it('spawns a visible pane in the current tab and cleans it up', async () => {
      const tabId = await currentPaneTabId()
      expect(tabId).toBeDefined()
      if (tabId === undefined)
        throw new Error('Expected current pane tab id in pane TUI context')

      const panesBefore = await listPanes()
      const paneIdsBeforeSpawn = new Set(
        panesBefore.flatMap((pane) => {
          const paneId = zellijID(pane.id) ?? zellijID(pane.pane_id)
          return paneId === undefined ? [] : [paneId]
        }),
      )

      // Spawn a pane that stays alive long enough for the test cycle.
      // `new-pane` should return the created pane ID as `terminal_<id>`.
      // We still sanity-check that parsed id against the pre-spawn pane list
      // so ambiguous output hard-fails instead of false-positive passing.
      const marker = `pane-tui-${Date.now()}`
      const currentPaneId = process.env.ZELLIJ_PANE_ID?.trim()

      let spawnSucceeded = false
      let safeCleanupPaneId: number | undefined
      let spawnOutput = ''
      let spawnedPaneIdStr = '<unparsed>'
      let spawnedPaneId: number | undefined
      try {
        spawnOutput = await runZellij([
          'action', 'new-pane',
          '--', 'bash', '-c', `echo ${marker}; sleep 30`,
        ])

        const spawnedPaneIdentity = verifySpawnedTerminalPaneIdentity({
          spawnOutput,
          currentPaneId,
          paneIdsBeforeSpawn,
        })

        spawnedPaneIdStr = spawnedPaneIdentity.normalizedPaneId
        spawnedPaneId = spawnedPaneIdentity.numericPaneId

        // Give Zellij a moment to settle the new pane
        await new Promise(resolve => setTimeout(resolve, 1000))

        const panesAfter = await listPanes()
        const spawnedPaneInfo = panesAfter.find(p => zellijID(p.id) === spawnedPaneId || zellijID(p.pane_id) === spawnedPaneId)
        expect(spawnedPaneInfo).toBeDefined()
        if (!spawnedPaneInfo)
          throw new Error(`Spawned pane ${spawnedPaneIdStr} (numeric ${spawnedPaneId}) not found in pane list`)

        // Core pane-context invariant: the spawned pane shares the same tab as
        // the original pane (new-pane opens in the current tab by default).
        const spawnedTabId = zellijID(spawnedPaneInfo.tab_id)
        expect(spawnedTabId).toBe(tabId)

        safeCleanupPaneId = spawnedPaneId
        spawnSucceeded = true
      }
      finally {
        // Cleanup guard: only close panes that were safely identified as the
        // newly spawned terminal pane. Unsafe / ambiguous parses hard-fail the
        // test and skip destructive cleanup so the current / outer pane cannot
        // be closed by mistake.
        if (safeCleanupPaneId === undefined) {
          console.warn(
            '[safety] Skipping close-pane because the spawned terminal pane was not safely identified\n'
            + `  current pane id: ${JSON.stringify(currentPaneId ?? '<missing>')}\n`
            + `  parsed pane id: ${JSON.stringify(spawnedPaneIdStr)}\n`
            + `  raw new-pane output: ${JSON.stringify(spawnOutput)}`,
          )
        }
        else {
          try {
            await runZellij(['action', 'close-pane', '--pane-id', String(safeCleanupPaneId)])
            await new Promise(resolve => setTimeout(resolve, 800))
          }
          catch {
            // Swallow cleanup errors — the spawned pane will close on
            // its own after the sleep(30) expires.
          }
        }
      }

      // Verify cleanup: the spawned pane should no longer be in the pane list.
      // This assertion only fires when the main test body succeeded
      // (spawnSucceeded), so we don't compound a prior failure with a
      // potentially flaky post-cleanup check.
      //
      // Use a short polling loop instead of a single-shot listPanes() call
      // so that the assertion is robust against Zellij cleanup timing
      // variation across host loads and Zellij versions.
      if (spawnSucceeded) {
        let stillPresent = true
        for (let attempt = 0; attempt < 6; attempt++) {
          const panesFinal = await listPanes()
          stillPresent = panesFinal.some(p => zellijID(p.id) === spawnedPaneId || zellijID(p.pane_id) === spawnedPaneId)
          if (!stillPresent)
            break
          if (attempt < 5)
            await new Promise(resolve => setTimeout(resolve, 500))
        }
        expect(stillPresent).toBe(false)
      }
    }, integrationTimeoutMs)
  })
}
else if (process.env.RUN_ZELLIJ_E2E === '1') {
  // Full E2E mode requires pane context; make the skip visible as a
  // hard failure so the CI / local runner does not silently green.
  it('E2E pane TUI suite requires pane context (ZELLIJ=1 + ZELLIJ_PANE_ID=<id> + ZELLIJ_SESSION_NAME=<session>)', () => {
    throw new Error(
      'Cannot run pane TUI tests: missing Zellij pane context.\n'
      + '  Run inside a Zellij pane, or set:\n'
      + '    ZELLIJ=1 ZELLIJ_PANE_ID=<current-pane-id> ZELLIJ_SESSION_NAME=<session>',
    )
  })
}
