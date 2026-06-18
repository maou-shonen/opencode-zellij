# opencode-zellij

[![npm version](https://img.shields.io/npm/v/opencode-zellij.svg)](https://www.npmjs.com/package/opencode-zellij)
[![CI](https://github.com/maou-shonen/opencode-zellij/actions/workflows/ci.yml/badge.svg)](https://github.com/maou-shonen/opencode-zellij/actions/workflows/ci.yml)

[正體中文](README.zh.md)

Run long-lived commands (dev servers, watchers, REPLs) in visible Zellij panes.

## Installation

Add the npm package name to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-zellij"]
}
```

OpenCode installs npm plugins automatically at startup. Zellij must also be installed and available on your `PATH`.

## Features

### `zellij_pty_spawn` tool
Open a Zellij pane to run a long-lived, interactive command.

**Quick reference:**

Call:

```json
{
  "command": "npm",
  "args": ["run", "dev"],
  "probe": { "type": "http", "url": "http://127.0.0.1:3000", "expectStatus": 200 }
}
```

Returns:

```json
{
  "session": { "id": "...", "paneId": "terminal_3" },
  "probe": { "ok": true, "type": "http", "message": "Got 200 from http://127.0.0.1:3000" },
  "output": { "text": "> next dev server running on :3000\n..." }
}
```

**Spec:**

- Start a long-running command and get a handle (`session.id`) to talk to it later. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Give short-lived commands a moment to produce output before returning. [`src/pty/probe.test.ts`](src/pty/probe.test.ts)
- Wait for an explicit ready signal (output match or HTTP) when the command needs one. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Catch a bad `grep` regex before a pane is created. [`src/tools/spawn.test.ts`](src/tools/spawn.test.ts)
- Find out which earlier panes are still hanging around before spawning more. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- When the pane exits, wake up the owning OpenCode session exactly once (de-duplicated across multiple terminal signals); falls back to `client.session.prompt` when `promptAsync` is unavailable; never wakes when no pane exits. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_read` tool
Read the recent output of a pane.

**Quick reference:**

Call:

```json
{ "id": "<session.id>", "grep": "error" }
```

Returns:

```json
{
  "session": { "id": "...", "status": "running", "exitCode": null },
  "output": { "text": "...matched lines...", "matched": 3 },
  "cleanup": { "requested": false, "performed": false, "alreadyClosed": false }
}
```

**Spec:**

- Pull the latest output from a pane, optionally filter it with `grep`, and learn its current state. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- A bad `grep` regex is reported as a warning instead of crashing the read. [`src/tools/read.test.ts`](src/tools/read.test.ts)
- Read output from a pane that already finished; tell `pane_closed` (killed externally) from `exit_marker` (process exited). [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Set the cleanup-on-read default globally (`pty.cleanupExitedPaneOnRead`) or per call (tool arg). [`src/tools/read.test.ts`](src/tools/read.test.ts)
- After read closes a finished pane, a second read returns the same close timestamp — useful for telling two reads apart. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_write` tool
Send input to a pane.

**Quick reference:**

Call:

```json
{ "id": "<session.id>", "data": "yes\n" }
```

Returns:

```json
{ "output": { "text": "...recent output after write..." } }
```

**Spec:**

- Send a reply (or keystroke) to an interactive pane and see how it responded. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- You can't accidentally type into a sudo pane — the write is refused. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_list` tool
List the panes this plugin is tracking.

**Quick reference:**

Call (all panes in the current OpenCode session):

```json
{}
```

Call (one pane):

```json
{ "id": "<session.id>" }
```

Returns:

```json
{
  "sessions": [
    { "id": "...", "paneId": "terminal_3", "status": "running", "command": "npm", "args": ["run", "dev"] }
  ],
  "completedPaneIds": ["..."],
  "completedPanes": [
    { "id": "...", "status": "exited", "reason": "exit_marker", "exitCode": 0 }
  ]
}
```

**Spec:**

- See what's still around (alive or finished) before spawning more, or look up one specific pane. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_kill` tool
Close a pane and forget it.

**Quick reference:**

Call:

```json
{ "id": "<session.id>" }
```

Returns (success):

```json
{
  "killed": true,
  "cleanedUp": true,
  "id": "...",
  "paneId": "terminal_3",
  "output": { "text": "...", "lineCount": 3 },
  "warnings": []
}
```

Returns (close-pane failed, pane still present):

```json
{
  "killed": false,
  "cleanedUp": false,
  "session": { "id": "...", "status": "unknown" },
  "output": { "text": "..." },
  "warnings": ["close-pane failed: ..."]
}
```

**Spec:**

- If the pane is already gone, the kill throws — wrap in try/catch for finally blocks (the e2e `killQuietly` helper does this). [`src/tools/kill.test.ts`](src/tools/kill.test.ts)
- Shut a pane down cleanly: Ctrl-C, brief pause, close-pane. Ctrl-C errors are warnings, not throws. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- If close-pane fails and the pane is still there, the session stays — retry later or read the warning. [`src/tools/kill.test.ts`](src/tools/kill.test.ts)
- If OpenCode dies before normal cleanup (Ctrl-D), a detached Node.js watchdog closes plugin-created panes so they don't leak. [`src/zellij/pane-watchdog.test.ts`](src/zellij/pane-watchdog.test.ts) · [`tests/e2e/ci-pane.test.ts`](tests/e2e/ci-pane.test.ts)

### `zellij_pty_request_sudo` tool
Open a floating, human-input-only review pane that shows the proposed command(s) and waits for the user to type `YES`.

**Quick reference:**

Call:

```json
{
  "summary": "Need root to install apt packages",
  "scripts": [
    { "command": "apt install -y libsqlite3-dev", "description": "Install build dependency for the local server." }
  ]
}
```

Returns:

```json
{
  "session": { "id": "...", "paneId": "terminal_5", "humanInputOnly": true }
}
```

**Spec:**

- Hand off a privileged command for the user to review and approve — they see the script and type `YES` themselves. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Credentials typed by the user stay in their terminal scrollback, never reach the agent or the LLM. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### Dynamic tab title
Update the Zellij tab title to show project, branch, and current OpenCode state. The title reads from the plugin-bound worktree's git (not from event payloads), so out-of-scope sessions and sibling worktrees can't pollute it.

**Spec:**

- [`tests/e2e/zellij-tab-title.run.test.ts`](tests/e2e/zellij-tab-title.run.test.ts)
- [`src/zellij/tab-title.test.ts`](src/zellij/tab-title.test.ts)

## Configuration

Sidecar config files load from `~/.config/opencode/opencode-zellij.config.jsonc` (user) and `.opencode/opencode-zellij.config.jsonc` (project). Project config overrides user config.

**`pty.enabled`** `boolean`, default `true`. Removes all `zellij_pty_*` tools when `false`.
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`pty.sudoPane`** `"allow" | "deny" | "hide"`, default `"allow"`. Controls `zellij_pty_request_sudo`: `"hide"` removes the tool, `"deny"` keeps it but rejects every call, `"allow"` (default) is the normal tool.
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`pty.cleanupExitedPaneOnRead`** `boolean`, default `true`. When `true`, `zellij_pty_read` on an exited pane closes the pane after returning output.

**`tabTitle.enabled`** `boolean`, default `true`. Disables dynamic tab title updates when `false`.
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`tabTitle.emojiIdle` / `emojiRunning` / `emojiNeedsInput` / `emojiBranch`** Strings, defaults `🟢` / `⚡` / `💬` / `🌱`. Prefixes for the state and branch segments.
**Spec:** [`tests/e2e/zellij-tab-title.run.test.ts`](tests/e2e/zellij-tab-title.run.test.ts)

**`tabTitle.debounceMs`** `number`, default `300`. Debounce window (ms) for tab title updates.

### Example

```jsonc
// .opencode/opencode-zellij.config.jsonc
{
  "$schema": "https://unpkg.com/opencode-zellij/opencode-zellij.schema.json",
  "pty": {
    "sudoPane": "deny"
  },
  "tabTitle": {
    "emojiRunning": "🔥",
    "emojiNeedsInput": "❓"
  }
}
```

The committed `opencode-zellij.schema.json` is generated from `src/config.ts` and used by editors with JSON Schema support.
**Spec:** [`tests/integration/config-schema.test.ts`](tests/integration/config-schema.test.ts)
