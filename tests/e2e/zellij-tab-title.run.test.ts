import { expect, it } from 'bun:test'
import { join } from 'node:path'
import process from 'node:process'
import { integration, integrationTimeoutMs } from './support/env.js'
import { defaultClient, disposeQuietly, loadPlugin, sendEvent } from './support/plugin.js'
import { observeStableTabTitle, waitForTabTitleValue, titleBody } from './support/assertions.js'
import { runGit, withTempGitProject } from './support/temp-project.js'
import { currentTabTitle, runZellij } from './support/zellij.js'

async function withSessionOnlyTarget<T>(run: () => Promise<T>): Promise<T> {
  const previousZellij = process.env.ZELLIJ
  const previousPaneId = process.env.ZELLIJ_PANE_ID

  delete process.env.ZELLIJ
  delete process.env.ZELLIJ_PANE_ID

  try {
    return await run()
  }
  finally {
    if (previousZellij === undefined)
      delete process.env.ZELLIJ
    else
      process.env.ZELLIJ = previousZellij

    if (previousPaneId === undefined)
      delete process.env.ZELLIJ_PANE_ID
    else
      process.env.ZELLIJ_PANE_ID = previousPaneId
  }
}

integration('real Zellij tab-title run integration', () => {
  it('restores the original tab title after disposed in session-only control', async () => {
    await withSessionOnlyTarget(async () => {
      // ── Checkpoint 1: session-only environment active ──
      // The production ZellijCli.currentTabTitle() checks ZELLIJ_PANE_ID
      // absence to select the session-only path (list-tabs --json, active tab
      // lookup via findActiveTabName).  If ZELLIJ_PANE_ID were still set,
      // the restore capture would use the pane-resolve path instead.
      // Explicitly assert the env is in session-only configuration.
      expect(process.env.ZELLIJ_SESSION_NAME?.trim()).toBeTruthy()
      expect(process.env.ZELLIJ).toBeUndefined()
      expect(process.env.ZELLIJ_PANE_ID).toBeUndefined()

      await withTempGitProject(async (projectRoot: string) => {
        // Capture the pre-test tab title for best-effort cleanup after the
        // test body completes.  This is read *after* env is in session-only
        // mode so it matches the tab scope the test operates on.
        const originalTabTitle = await currentTabTitle()

        // ── Checkpoint 2: seed unique original title ──
        // Use a raw Zellij action to rename the active tab to a timestamped
        // unique string before plugin load.  This proves the restore target
        // is a real Zellij tab state — not a helper-side expected string —
        // and gives the test an unambiguous value to verify after dispose.
        const uniqueOriginalTitle = `opencode-zellij-run-restore-${Date.now()}`
        await runZellij(['action', 'rename-tab', uniqueOriginalTitle])

        const renamedTitle = await waitForTabTitleValue(title => title === uniqueOriginalTitle)
        expect(renamedTitle).toBe(uniqueOriginalTitle)

        // ── Checkpoint 3: real built plugin → dynamic title ──
        // loadPlugin() imports the production build (dist/index.mjs) and
        // instantiates the real TabTitleManager.  TabTitleManager's
        // constructor calls saveOriginalTabTitle() → ZellijCli.currentTabTitle()
        // which captures the seeded original under session-only rules.
        // Sending session.created + session.status then triggers the
        // production render path and writes a dynamic project title.
        const hooks = await loadPlugin({
          directory: projectRoot,
          worktree: projectRoot,
          client: defaultClient(),
        })

        try {
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'session-only-restore', directory: projectRoot } } })
          await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'session-only-restore', status: { type: 'busy' } } })

          const dynamicTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(
            title?.startsWith('⚡')
            && title.includes('project')
            && title.includes('main')
            && title !== uniqueOriginalTitle,
          ))
          expect(dynamicTitle).toBeDefined()
          // Explicitly assert the active tab title changed away from the
          // seeded original — proves the plugin path produced a different
          // value and that restore is not a tautology.
          expect(dynamicTitle).not.toBe(uniqueOriginalTitle)

          // ── Checkpoint 4: server.instance.disposed → restore ──
          // The production event handler routes disposed to
          // TabTitleManager.destroy(), which calls
          // restoreOriginalTabTitle() → ZellijCli.renameTab(title)
          // with the captured originalTabTitle.  Observe the tab title
          // returns to the exact uniqueOriginalTitle string and remains
          // stable for the stability window.
          await sendEvent(hooks, { type: 'server.instance.disposed', properties: {} })

          const result = await observeStableTabTitle({
            expected: uniqueOriginalTitle,
            timeoutMs: 8_000,
            stabilityMs: 1_000,
          })
          expect(result.ok).toBe(true)
          // Confirm the restored value is exactly the seeded original,
          // not a substring or a best-effort partial match.
          expect(result.title).toBe(uniqueOriginalTitle)
        }
        finally {
          // ── Checkpoint 5: cleanup must not mask restore failure ──
          // All restore assertions (checkpoint 4) run *before* this finally
          // block.  If the production restore path failed, the assertions
          // would fail first — cleanup cannot hide a missing restore.
          await disposeQuietly(hooks)
          if (originalTabTitle !== undefined) {
            try {
              await runZellij(['action', 'rename-tab', originalTabTitle])
            }
            catch {
              // best-effort — restore the pre-test title when possible
            }
          }
        }
      })
    })
  }, integrationTimeoutMs)

  it('does not change the real tab title when tabTitle.enabled is false', async () => {
    await withSessionOnlyTarget(async () => {
      await withTempGitProject(async (projectRoot: string) => {
        const originalTabTitle = await currentTabTitle()
        const uniqueOriginalTitle = `opencode-zellij-disabled-${Date.now()}`
        await runZellij(['action', 'rename-tab', uniqueOriginalTitle])

        const renamedTitle = await waitForTabTitleValue(title => title === uniqueOriginalTitle)
        expect(renamedTitle).toBe(uniqueOriginalTitle)

        const hooks = await loadPlugin({
          directory: projectRoot,
          worktree: projectRoot,
          client: defaultClient(),
        })

        try {
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'disabled-title-session', directory: projectRoot } } })
          await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'disabled-title-session', status: { type: 'busy' } } })
          await sendEvent(hooks, { type: 'question.asked', properties: { id: 'disabled-title-question', sessionID: 'disabled-title-session' } })
          await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'disabled-title-session' } })

          const stableTitle = await observeStableTabTitle({
            expected: uniqueOriginalTitle,
            timeoutMs: 5_000,
            stabilityMs: 1_000,
          })

          expect(stableTitle.ok).toBe(true)
          expect(stableTitle.title).toBe(uniqueOriginalTitle)
        }
        finally {
          await disposeQuietly(hooks)
          if (originalTabTitle !== undefined) {
            try {
              await runZellij(['action', 'rename-tab', originalTabTitle])
            }
            catch {
              // best-effort — restore the pre-test title when possible
            }
          }
        }
      }, { configContent: '{ "tabTitle": { "enabled": false } }' })
    })
  }, integrationTimeoutMs)

  it('keeps status changes from altering project and branch', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'scoped-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'scoped-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(runningTitle).toBeDefined()
        expect(titleBody(runningTitle!)).toBe(titleBody(idleTitle!))

        await runGit(['checkout', '-b', 'feature/e2e'], projectRoot)
        await sendEvent(hooks, { type: 'vcs.branch.updated', properties: { branch: 'wrong-branch' } })

        const branchTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('feature/e2e')))
        expect(branchTitle).toBeDefined()
        expect(branchTitle).not.toContain('wrong-branch')
        expect(titleBody(branchTitle!)).toContain('🌱 feature/e2e')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('loads custom tab title emojis from real plugin config on the actor path', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(
          title?.startsWith('I') &&
          title.includes('project') &&
          title.includes('main') &&
          titleBody(title).includes('B main'),
        ))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'custom-emojis-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'custom-emojis-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(
          title?.startsWith('R') &&
          title.includes('project') &&
          title.includes('main') &&
          titleBody(title).includes('B main'),
        ))
        expect(runningTitle).toBeDefined()

        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'custom-emojis-question', sessionID: 'custom-emojis-session' } })

        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(
          title?.startsWith('Q') &&
          title.includes('project') &&
          title.includes('main') &&
          titleBody(title).includes('B main'),
        ))
        expect(needsInputTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    }, { configContent: '{ "tabTitle": { "enabled": true, "emojiIdle": "I", "emojiRunning": "R", "emojiNeedsInput": "Q", "emojiBranch": "B" } }' })
  }, integrationTimeoutMs)

  it('switches from busy to idle for the same session', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'busy-idle-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'busy-idle-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(busyTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'busy-idle-session' } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleAgainTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('cleans up busy status when the session is deleted', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'busy-deleted-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'busy-deleted-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(busyTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'busy-deleted-session' } } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleAgainTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('keeps parent running when a child session idles or is deleted', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'parent-running-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'child-running-session', directory: projectRoot, parentID: 'parent-running-session' } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'parent-running-session', status: { type: 'busy' } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'child-running-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(runningTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'child-running-session' } })

        const stillRunningAfterChildIdle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(stillRunningAfterChildIdle).toBeDefined()

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'child-running-session' } } })

        const stillRunningAfterChildDeleted = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(stillRunningAfterChildDeleted).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('cleans up child state when the parent session is deleted', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'cascade-parent-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'cascade-child-session', directory: projectRoot, parentID: 'cascade-parent-session' } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'cascade-child-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(busyTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'cascade-parent-session' } } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleAgainTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('returns to running after scoped question needs input lifecycle', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'question-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'question-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(runningTitle).toBeDefined()

        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q1', sessionID: 'question-session' } })
        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('💬') && title.includes('project') && title.includes('main')))
        expect(needsInputTitle).toBeDefined()

        await sendEvent(hooks, { type: 'question.replied', properties: { requestID: 'q1', sessionID: 'question-session' } })
        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(resumedTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('returns to idle when pending input is cleared after session deletion', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'pending-deleted-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-pending-delete', sessionID: 'pending-deleted-session' } })

        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('💬') && title.includes('project') && title.includes('main')))
        expect(needsInputTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'pending-deleted-session' } } })

        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(resumedTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('keeps permission lifecycle updates on the current session title', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'permission-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'permission-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(busyTitle).toBeDefined()

        await sendEvent(hooks, { type: 'permission.asked', properties: { id: 'p1', sessionID: 'permission-session' } })
        const askedTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('💬') && title.includes('project') && title.includes('main')))
        expect(askedTitle).toBeDefined()

        await sendEvent(hooks, { type: 'permission.updated', properties: { id: 'p1', sessionID: 'permission-session', status: 'approved' } })
        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('⚡') && title.includes('project') && title.includes('main')))
        expect(resumedTitle).toBeDefined()

        await sendEvent(hooks, { type: 'permission.asked', properties: { id: 'p2', sessionID: 'permission-session' } })
        const secondAskedTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('💬') && title.includes('project') && title.includes('main')))
        expect(secondAskedTitle).toBeDefined()

        await sendEvent(hooks, { type: 'permission.replied', properties: { requestID: 'p2', sessionID: 'permission-session' } })
        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'permission-session' } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleAgainTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('returns to idle after scoped question rejection clears needs input', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'question-rejected-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-rejected', sessionID: 'question-rejected-session' } })

        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('💬') && title.includes('project') && title.includes('main')))
        expect(needsInputTitle).toBeDefined()

        await sendEvent(hooks, { type: 'question.rejected', properties: { requestID: 'q-rejected', sessionID: 'question-rejected-session' } })
        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'question-rejected-session' } })

        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(resumedTitle).toBeDefined()
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('ignores out-of-scope sessions and input events', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const initialTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(initialTitle).toBeDefined()

        await withTempGitProject(async (otherRoot: string) => {
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'other-session', directory: otherRoot } } })
          await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'other-session', status: { type: 'busy' } } })
          await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-other', sessionID: 'other-session' } })
        })

        const unchangedTitle = await observeStableTabTitle({
          expected: initialTitle!,
          forbidden: (title: string | undefined) => Boolean(
            title?.startsWith('⚡') ||
            title?.startsWith('💬') ||
            title?.includes('other-session') ||
            title?.includes('q-other'),
          ),
        })
        expect(unchangedTitle.ok).toBe(true)
        expect(unchangedTitle.title).toBe(initialTitle)
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('ignores out-of-scope parent and child session events', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(idleTitle).toBeDefined()

        await withTempGitProject(async (otherRoot: string) => {
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'other-parent-session', directory: otherRoot } } })
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'other-child-session', directory: otherRoot, parentID: 'other-parent-session' } } })
          await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'other-child-session', status: { type: 'busy' } } })
          await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-other-child', sessionID: 'other-child-session' } })
        })

        const stableTitle = await observeStableTabTitle({
          expected: idleTitle!,
          forbidden: (title: string | undefined) => Boolean(
            title?.startsWith('⚡') ||
            title?.startsWith('💬') ||
            title?.includes('other-parent-session') ||
            title?.includes('other-child-session'),
          ),
        })
        expect(stableTitle.ok).toBe(true)
        expect(stableTitle.title).toBe(idleTitle)
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)

  it('keeps the bound worktree authoritative when a sibling worktree changes', async () => {
    await withTempGitProject(async (projectRoot: string) => {
      const siblingWorktree = join(projectRoot, '..', 'worktree-b')
      await runGit(['worktree', 'add', '-b', 'feature/e2e', siblingWorktree, 'main'], projectRoot)

      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const initialTitle = await waitForTabTitleValue((title: string | undefined) => Boolean(title?.startsWith('🟢') && title.includes('project') && title.includes('main')))
        expect(initialTitle).toBeDefined()

        await sendEvent(hooks, { type: 'vcs.branch.updated', properties: { branch: 'feature/e2e' } })

        const stableTitle = await observeStableTabTitle({
          expected: (title: string | undefined) => Boolean(title?.includes('main')),
          forbidden: (title: string | undefined) => Boolean(title?.includes('feature/e2e')),
        })
        expect(stableTitle.ok).toBe(true)
        expect(stableTitle.title).toContain('main')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, integrationTimeoutMs)
})
