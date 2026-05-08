# opencode-zellij

[![npm version](https://img.shields.io/npm/v/opencode-zellij.svg)](https://www.npmjs.com/package/opencode-zellij)
[![CI](https://github.com/maou-shonen/opencode-zellij/actions/workflows/ci.yml/badge.svg)](https://github.com/maou-shonen/opencode-zellij/actions/workflows/ci.yml)

[正體中文](README.zh.md)

Give OpenCode a way to use visible Zellij panes for work that should not disappear into a one-shot tool call.

Use OpenCode's built-in `bash` for normal commands. Use this plugin when the process should stay alive, remain visible, or need later input.

## Installation

Add the npm package name to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-zellij"
  ]
}
```

OpenCode installs npm plugins automatically at startup. Zellij must also be installed and available on your `PATH`.

## Good fits

- dev servers and watchers
- REPLs and interactive CLIs
- SSH or remote sessions
- commands that ask follow-up questions
- privileged commands that need human review

## Ask OpenCode like this

```text
Start the dev server in a visible Zellij pane and wait until it is ready.
```

```text
Check the server pane for errors.
```

```text
Send Enter to the interactive pane and show me the latest output.
```

```text
Open a human-reviewed pane for the sudo install step.
```

```text
Close the dev server pane.
```

## Tools

| Tool | Use |
| --- | --- |
| `zellij_pty_spawn` | Start a visible Zellij pane. |
| `zellij_pty_read` | Read recent pane output. |
| `zellij_pty_write` | Send input to an interactive pane. |
| `zellij_pty_list` | Show panes known to the plugin. |
| `zellij_pty_kill` | Close a pane created by the plugin. |
| `zellij_pty_request_sudo` | Ask the user to review and run privileged commands in Zellij. |

## Human-only work

`zellij_pty_request_sudo` opens a review pane, shows what will run, and waits for the user to type `YES`. The agent cannot type into that pane, so passwords and credentials stay in Zellij instead of entering prompts or tool arguments.

## Dynamic tab title

When OpenCode runs inside Zellij, the plugin updates the current tab title to show the project, branch, and current OpenCode state:

```text
🟢 opencode-zellij 🌱 main        # ready
⚡ opencode-zellij 🌱 main        # agent running
💬 opencode-zellij 🌱 main        # waiting for user input
```

The title is updated best-effort from OpenCode session, question, permission, and branch events.

## Pane cleanup watchdog

When the plugin creates a pane, it also starts a small detached Node.js watchdog process for that OpenCode plugin instance. The watchdog keeps a per-instance registry under `$XDG_RUNTIME_DIR/opencode-zellij-*` (or the system temp directory), watches the owning OpenCode process, and closes plugin-created panes if OpenCode exits before normal plugin cleanup can run, such as when leaving with Ctrl-D.

The watchdog exits automatically after the owner process exits and cleanup is complete. Registries are isolated per OpenCode process and plugin instance.

## Notes

- This is not a sandbox.
- Session records are in-memory only; restarting OpenCode loses them.
- Output is rendered Zellij output, not raw PTY bytes.
- Exit code capture is best-effort for commands started by the plugin.
- When dynamic tab title is enabled, it may overwrite manual Zellij tab renames on the next OpenCode state change.
