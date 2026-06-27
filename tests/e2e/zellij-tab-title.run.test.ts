import { describe, expect, it } from 'bun:test'
import { currentPaneTabId, renameTabById } from '../../src/lib/zellij/pane.js'
import { observeStableTabTitle, waitForTabTitleValue } from './support/assertions.js'
import { withTempProject } from './support/temp-project.js'
import { defaultClient, disposeQuietly, loadPlugin, sendEvent } from './support/plugin.js'

describe('tab title status lifecycle', () => {
  it('switches from idle to running when a scoped session becomes busy', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(idleTitle).toBe('my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'scoped-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'scoped-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(runningTitle).toBe('my-tab ⚡')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('returns to idle when the session goes idle', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'busy-idle-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'busy-idle-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(busyTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'busy-idle-session' } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(idleAgainTitle).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('cleans up busy status when the session is deleted', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'busy-deleted-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'busy-deleted-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(busyTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'busy-deleted-session' } } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(idleAgainTitle).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('keeps parent running when a child session idles or is deleted', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'parent-running-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'child-running-session', directory: projectRoot, parentID: 'parent-running-session' } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'parent-running-session', status: { type: 'busy' } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'child-running-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(runningTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'child-running-session' } })

        const stillRunningAfterChildIdle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(stillRunningAfterChildIdle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'child-running-session' } } })

        const stillRunningAfterChildDeleted = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(stillRunningAfterChildDeleted).toBe('my-tab ⚡')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('cleans up child state when the parent session is deleted', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'cascade-parent-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'cascade-child-session', directory: projectRoot, parentID: 'cascade-parent-session' } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'cascade-child-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(busyTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'cascade-parent-session' } } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(idleAgainTitle).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('returns to running after scoped question needs input lifecycle', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'question-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'question-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(runningTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q1', sessionID: 'question-session' } })
        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 💬')
        expect(needsInputTitle).toBe('my-tab 💬')

        await sendEvent(hooks, { type: 'question.replied', properties: { requestID: 'q1', sessionID: 'question-session' } })
        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(resumedTitle).toBe('my-tab ⚡')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('returns to idle when pending input is cleared after session deletion', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'pending-deleted-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-pending-delete', sessionID: 'pending-deleted-session' } })

        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 💬')
        expect(needsInputTitle).toBe('my-tab 💬')

        await sendEvent(hooks, { type: 'session.deleted', properties: { info: { id: 'pending-deleted-session' } } })

        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(resumedTitle).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('keeps permission lifecycle updates on the current title', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'permission-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'permission-session', status: { type: 'busy' } } })

        const busyTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(busyTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'permission.asked', properties: { id: 'p1', sessionID: 'permission-session' } })
        const askedTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 💬')
        expect(askedTitle).toBe('my-tab 💬')

        await sendEvent(hooks, { type: 'permission.updated', properties: { id: 'p1', sessionID: 'permission-session', status: 'approved' } })
        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab ⚡')
        expect(resumedTitle).toBe('my-tab ⚡')

        await sendEvent(hooks, { type: 'permission.asked', properties: { id: 'p2', sessionID: 'permission-session' } })
        const secondAskedTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 💬')
        expect(secondAskedTitle).toBe('my-tab 💬')

        await sendEvent(hooks, { type: 'permission.replied', properties: { requestID: 'p2', sessionID: 'permission-session' } })
        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'permission-session' } })

        const idleAgainTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(idleAgainTitle).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)

  it('returns to idle after scoped question rejection clears needs input', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'question-rejected-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-rejected', sessionID: 'question-rejected-session' } })

        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 💬')
        expect(needsInputTitle).toBe('my-tab 💬')

        await sendEvent(hooks, { type: 'question.rejected', properties: { requestID: 'q-rejected', sessionID: 'question-rejected-session' } })
        await sendEvent(hooks, { type: 'session.idle', properties: { sessionID: 'question-rejected-session' } })

        const resumedTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(resumedTitle).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)
})

describe('tab title out-of-scope filter', () => {
  it('ignores out-of-scope session and input events', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const initialTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab 🟢')
        expect(initialTitle).toBe('my-tab 🟢')

        await withTempProject(async (otherRoot: string) => {
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'other-parent-session', directory: otherRoot } } })
          await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'other-child-session', directory: otherRoot, parentID: 'other-parent-session' } } })
          await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'other-child-session', status: { type: 'busy' } } })
          await sendEvent(hooks, { type: 'question.asked', properties: { id: 'q-other-child', sessionID: 'other-child-session' } })
        })

        const stableTitle = await observeStableTabTitle({
          expected: 'my-tab 🟢',
          forbidden: (title: string | undefined) => Boolean(
            title === 'my-tab ⚡' ||
            title === 'my-tab 💬',
          ),
        })
        expect(stableTitle.ok).toBe(true)
        expect(stableTitle.title).toBe('my-tab 🟢')
      }
      finally {
        await disposeQuietly(hooks)
      }
    })
  }, 15_000)
})

describe('tab title emoji config', () => {
  it('loads custom status emojis from real plugin config on the actor path', async () => {
    await withTempProject(async (projectRoot: string) => {
      await renameTabById(await currentPaneTabId(), 'my-tab')
      const hooks = await loadPlugin({
        directory: projectRoot,
        worktree: projectRoot,
        client: defaultClient(),
      })

      try {
        const idleTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab I')
        expect(idleTitle).toBe('my-tab I')

        await sendEvent(hooks, { type: 'session.created', properties: { info: { id: 'custom-emojis-session', directory: projectRoot } } })
        await sendEvent(hooks, { type: 'session.status', properties: { sessionID: 'custom-emojis-session', status: { type: 'busy' } } })

        const runningTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab R')
        expect(runningTitle).toBe('my-tab R')

        await sendEvent(hooks, { type: 'question.asked', properties: { id: 'custom-emojis-question', sessionID: 'custom-emojis-session' } })

        const needsInputTitle = await waitForTabTitleValue((title: string | undefined) => title === 'my-tab Q')
        expect(needsInputTitle).toBe('my-tab Q')
      }
      finally {
        await disposeQuietly(hooks)
      }
    }, { configContent: '{ "tabTitle": { "enabled": true, "emojiIdle": "I", "emojiRunning": "R", "emojiNeedsInput": "Q" } }' })
  }, 15_000)
})
