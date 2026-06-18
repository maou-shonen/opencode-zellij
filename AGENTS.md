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
- `mise run test-e2e` is the single public E2E entrypoint. **Do not run `bun run test:e2e` directly** — the suite is meant to be replayed through the `act` task defined in `mise.toml`. Locally `mise run test-e2e` shells out to `act -j e2e`, which reuses the GitHub Actions `e2e` job definition (start a dedicated Zellij session, run `mise run test-integration`, then the pane-orchestration E2E coverage; the pane itself runs the native real-environment E2E suite including TUI coverage). Inside GitHub Actions or an `act` runner it short-circuits `act` and runs the pane-side suite directly.
- **Never bypass `act` for E2E.** Do not invoke `bun test tests/e2e/...` (with or without `RUN_ZELLIJ_E2E=1`) as a stand-in for `mise run test-e2e`, even when `act` is too expensive or slow in the current environment. `act` is the only path that exercises the same job definition CI runs, and ad‑hoc invocations can pass locally while diverging from the CI contract. If the local environment cannot run `act` (e.g. no Docker daemon, not enough disk for the `ubuntu:act-24.04` image), report that as a blocker instead of substituting a different command.
- The act runner image is pinned to `ghcr.io/catthehacker/ubuntu:act-24.04` (the medium-size variant that `nektos/act` recommends, smaller than the `act-latest` full-runner image and aligned with CI's `ubuntu-latest` = Ubuntu 24.04). Update `package.json` if the CI runner image changes.
- `act` is part of the toolchain (declared in `mise.toml` `[tools]`), so `mise install` provides it. If you change the `e2e` job shape, keep `mise run test-e2e` as the only documented way to invoke it.
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

## Test-as-spec discipline

`README.md` doubles as a lightweight spec: every tool, feature, and configuration option listed there is bound to a `describe(...)` group in a test file via the `**Spec:**` section. The contract is therefore **tests, not prose**.

### Rules

- **One `describe` group per README section.** The group name must read like a section heading (e.g. `tab title activity lifecycle`, not `running idle switch`). Mechanical name lookup is performed by `mise run lint-readme`.
- **`it` names read as clauses.** Each `it('...')` should read as a complete sentence about behavior (`it('keeps project and branch across status changes', ...)`, not `it('test1', ...)`).
- **One feature, one group.** Do not scatter a single feature's cases across multiple top-level groups. If the group is getting large, split the feature — not the group.
- **Helper-only test files are not specs.** Files under `tests/**/support/` (and any file whose only purpose is fixture/helper verification) are excluded from spec linking.
- **Do not invent specs.** If a behavior has no test, do not list it under `**Spec:**` in the README. Either add a test, or remove the README claim. Honest gaps are fine; false specs are not.

### Update discipline

- Changing a spec'd behavior **must** update the linked `describe` group AND the README's `**Spec:**` section in the same commit.
- Renaming a `describe` group is a breaking spec change: README links will go stale and `mise run lint-readme` will fail. Treat renames as deliberate and update README in the same commit.
- Adding a new tool, feature, or config option without a test link is a review blocker.

### Verification

- `mise run lint-readme` extracts every `tests/...` path from `README.md` and `README.zh.md`, verifies the file exists, and lists the `describe` groups inside so a reviewer can confirm the link target reads like the corresponding section.
- This is part of the default `mise run check` quality gate.

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
