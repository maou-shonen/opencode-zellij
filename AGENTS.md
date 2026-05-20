# AGENTS.md

## Scope

This repository ships the `opencode-zellij` OpenCode plugin: visible Zellij pane tools, human-reviewed sudo panes, pane cleanup watchdogs, and dynamic tab titles.

## Toolchain

- Use `mise` for tool installation and as the public entrypoint for setup, validation, and release tasks.
- Prefer documenting and running `mise run <task>` commands instead of raw package-manager scripts.
- Keep Bun as an implementation detail behind `mise.toml` tasks unless a change specifically needs package-script internals.

## Setup

```bash
mise install
mise run install
```

## Common tasks

```bash
mise run build
mise run check
mise run test-integration
mise run test-e2e
```

## Validation expectations

- `mise run check` is the default quality gate. It covers typecheck, lint, unit tests, and build.
- `mise run test-e2e` is the single public E2E entrypoint. Locally it replays the GitHub Actions `e2e` job with `act`; inside GitHub Actions or an `act` runner it runs the pane-orchestration E2E coverage, and the pane itself runs the native real-environment E2E suite including TUI coverage.
- `mise run test-integration` is targeted real Zellij integration coverage for plugin loading, pane lifecycle, cleanup, and tool wiring changes.
- Zellij-backed tests require running inside Zellij or setting `ZELLIJ_SESSION_NAME` to a live session.

## CI and release flow

- `.github/workflows/ci.yml`
  - `Check` runs `mise run check`
  - `E2E` starts a dedicated Zellij session, then runs `mise run test-integration` and `mise run test-e2e`; in runner environments that single task still keeps pane orchestration covered while the pane runs the native E2E suite.
- `.github/workflows/preview.yml` publishes preview packages for branch pushes and pull requests.
- `.github/workflows/publish.yml` publishes `v*` tags, runs checks, publishes to npm, then syncs `package.json` back to `main`.
- Prefer `act` over bespoke Docker runners for local CI reproduction.

## Repository guardrails

- Keep the existing TypeScript ESM and no-semicolon style.
- Prefer small, focused changes over broad refactors.
- Reuse helpers under `tests/e2e/support/` instead of duplicating Zellij setup logic.
- Do not reintroduce the removed Docker-based E2E path.

## Tab title invariants

When touching `src/zellij/tab-title.ts` and related tests, preserve these rules:

- Keep identity, activity, and rendering concerns separated.
- Keep live `running`, `idle`, and `needs-input` status updates.
- Branch display must come from plugin-bound worktree git reads, not from event payloads.
- Unknown or out-of-scope session, status, or input events must not overwrite the visible title.
- Track needs-input state by `(sessionID, requestID)`.
- `TabTitleManager` should stay focused on rendering, debounce, retry, and restore behavior rather than owning session activity state.

## PTY and sudo invariants

- Long-lived or interactive work should stay in visible Zellij panes.
- `zellij_pty_request_sudo` must remain human-input-only. Agents must not gain write access to that pane.
- Pane cleanup changes must preserve the watchdog-backed cleanup path for abnormal OpenCode exits.
