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
- Give short-lived commands a moment to produce output before returning. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Wait for an explicit ready signal (output match or HTTP) when the command needs one. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Catch a bad `grep` regex before a pane is created. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
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
- A bad `grep` regex is reported as a warning instead of crashing the read. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Read output from a pane that already finished; tell `pane_closed` (killed externally) from `exit_marker` (process exited). [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Set the cleanup-on-read default globally (`pty.cleanupExitedPaneOnRead`) or per call (tool arg). [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
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
- Writing to a `humanInputOnly` session (any `zellij_pty_request_sudo` pane) **throws** an error from this tool — it does not silently fail with a warning. The agent must not bypass this guard by shelling out to `zellij action write-chars` directly; the user owns all input to those panes. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

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

- If the pane is already gone, the kill throws — wrap in try/catch for finally blocks (the e2e `killQuietly` helper does this). [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Shut a pane down cleanly: Ctrl-C, brief pause, close-pane. Ctrl-C errors are warnings, not throws. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- If close-pane fails and the pane is still there, the session stays — retry later or read the warning. [`src/tools/kill.test.ts`](src/tools/kill.test.ts)
- If OpenCode dies before normal cleanup (Ctrl-D), a detached Node.js watchdog closes plugin-created panes so they don't leak. [`tests/e2e/ci-pane.test.ts`](tests/e2e/ci-pane.test.ts)

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

- Hand off a privileged command for the user to review and approve — they see the script and confirm via a strict `[y/n]` prompt with **no implicit default**. The user must type `y` (or `Y`) explicitly to approve, or `n` (or `N`) to cancel. **Empty Enter and any other input loops back to the prompt with feedback** — a stray Enter from a fast double-tap must not silently cancel a request the user never explicitly declined. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- Credentials typed by the user stay in their terminal scrollback, never reach the agent or the LLM. [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- A 3s countdown ticks down on a single line (3 → 2 → 1, using `\r` overwrites) before the strict `[y/n]` prompt. Empty Enter and stray input are rejected with feedback and re-prompted; only explicit `y`/`Y` approves and only `n`/`N` cancels. The countdown and prompt render in the Zellij pane in the expected order. [`src/tools/request-sudo.test.ts`](src/tools/request-sudo.test.ts), [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- The pane is spawned with `--close-on-exit`, so Zellij closes the floating pane the moment bash exits — the user is not left looking at a dead terminal with stale output after approval or cancel. [`src/zellij/cli.test.ts`](src/zellij/cli.test.ts), [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- The pane is large and pinned by default (`sudoPaneFloatingSize`) and the title includes a `⚠ sudo:` prefix so the user can spot the request in their Zellij layout. The default mode is `floating`, which does not steal keyboard focus; switch `sudoPaneMode` to `fullscreen` if you keep missing the floating pane. [`src/config.test.ts`](src/config.test.ts), [`src/zellij/cli.test.ts`](src/zellij/cli.test.ts)

### Dynamic tab title
Append a status emoji to the current Zellij tab title to show the OpenCode state (idle / running / needs-input). The status emoji is appended at the end and replaced on state changes, so your original tab title is preserved.

**Spec:**

- [`tests/e2e/zellij-tab-title.run.test.ts`](tests/e2e/zellij-tab-title.run.test.ts)

## Configuration

Sidecar config files load from `~/.config/opencode/opencode-zellij.config.jsonc` (user) and `.opencode/opencode-zellij.config.jsonc` (project). Project config overrides user config.

**`pty.enabled`** `boolean`, default `true`. Removes all `zellij_pty_*` tools when `false`.
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`pty.sudoPane`** `"allow" | "deny" | "hide"`, default `"allow"`. Controls `zellij_pty_request_sudo`: `"hide"` removes the tool, `"deny"` keeps it but rejects every call, `"allow"` (default) is the normal tool.
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`pty.sudoPaneMode`** `"floating" | "fullscreen"`, default `"floating"`. How the sudo request pane is presented. `floating` opens a large, pinned floating pane that does not steal keyboard focus; `fullscreen` opens a non-floating pane that Zellij focuses automatically. Switch to `fullscreen` if you keep missing the floating pane.
**Spec:** [`src/tools/request-sudo.test.ts`](src/tools/request-sudo.test.ts), [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

**`pty.sudoPaneFloatingSize`** `{ width?: string, height?: string, pinned?: boolean }`. Size of the floating sudo pane when `sudoPaneMode` is `"floating"`. `width` and `height` accept a percent string (e.g. `"80%"`) or a bare integer in cells; `pinned` keeps the pane on top of other floating panes. Defaults: `{ width: "80%", height: "60%", pinned: true }`.
**Spec:** [`src/config.test.ts`](src/config.test.ts), [`src/zellij/cli.test.ts`](src/zellij/cli.test.ts)

**`pty.cleanupExitedPaneOnRead`** `boolean`, default `true`. When `true`, `zellij_pty_read` on an exited pane closes the pane after returning output.
**Spec:** [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

**`tabTitle.enabled`** `boolean`, default `true`. Disables dynamic tab title updates when `false`.
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`tabTitle.emojiIdle` / `emojiRunning` / `emojiNeedsInput`** Strings, defaults `🟢` / `⚡` / `💬`. Prefixes for the state segment.
**Spec:** [`tests/e2e/zellij-tab-title.run.test.ts`](tests/e2e/zellij-tab-title.run.test.ts)

**`tabTitle.debounceMs`** `number`, default `300`. Debounce window (ms) for tab title updates.

### Example

```jsonc
// .opencode/opencode-zellij.config.jsonc
{
  "$schema": "https://unpkg.com/opencode-zellij/opencode-zellij.schema.json",
  "pty": {
    "sudoPane": "deny",
    "sudoPaneMode": "floating",
    "sudoPaneFloatingSize": { "width": "80%", "height": "60%", "pinned": true }
  },
  "tabTitle": {
    "emojiRunning": "🔥",
    "emojiNeedsInput": "❓"
  }
}
```

The committed `opencode-zellij.schema.json` is generated from `src/config.ts` and used by editors with JSON Schema support.
**Spec:** [`tests/integration/config-schema.test.ts`](tests/integration/config-schema.test.ts)
