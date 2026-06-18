# AGENTS.md

## Scope

This repository ships the `opencode-zellij` OpenCode plugin: visible Zellij pane tools, human-reviewed sudo panes, pane cleanup watchdogs, and dynamic tab titles.

## Toolchain

- Use `mise` for installation, setup, validation, and release.
- Document and run `mise run <task>` instead of raw package-manager scripts.
- Bun stays an implementation detail behind `mise.toml` tasks.

## Tasks

`mise install` runs the `postinstall` hook (`bun install` + `lefthook install`). Available tasks:

!`mise tasks --local`

## Validation

- `mise run check` is the default quality gate (typecheck, lint, unit tests, build, lint:readme).
- `mise run test-e2e` is the only E2E entrypoint. It shells out to `act -j e2e`; the GitHub Actions job definition is the contract. **Never bypass it** with `bun test tests/e2e/...`, even when `act` is slow — ad-hoc runs can pass locally while diverging from CI. If the environment can't run `act` at all (no Docker, no disk for `ubuntu:act-24.04`), report the blocker.
- The act runner image is pinned in `package.json` to `ghcr.io/catthehacker/ubuntu:act-24.04`.
- `mise run test-integration` runs real Zellij coverage (plugin load, pane lifecycle, cleanup, tool wiring). Requires running inside Zellij or `ZELLIJ_SESSION_NAME` pointing at a live session.

## CI and release

- `ci.yml` — `Check` runs `mise run check`; `E2E` runs integration + e2e inside a Zellij session.
- `preview.yml` — preview packages on PR and branch pushes.
- `publish.yml` — `v*` tags run checks, publish to npm, then sync `package.json` back to `main`.
- Use `act` for local CI reproduction, not ad-hoc Docker.

## Repository guardrails

- TypeScript ESM, no-semicolon style.
- Small, focused changes.
- Reuse helpers under `tests/e2e/support/` instead of duplicating Zellij setup logic.
- Don't reintroduce the removed Docker-based E2E path.

## README as spec

`README.md` is the spec; tests are the source of truth. Every tool, feature, and config option is bound to a top-level `describe(...)` via the section's `**Spec:**` link. Bidirectional — a claim must point at a real test, and the linked test owns that behavior.

A section that ships behavior ends with:

```markdown
**Spec:** [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
```

The linked file's top-level `describe` groups should each read like a section heading. Helper-only files under `tests/**/support/` are not specs.

### Contributor checklist

When you add or change a feature:

1. Add or update the `describe` group. `it` names read as clauses about behavior.
2. Add or update the `**Spec:**` link in the README, in the same commit. A `describe` rename is breaking.
3. Run `mise run check` — it runs `lint:readme` and fails on dead links.

One feature, one group. If a behavior has no test, do not list it in the README. Honest gaps are fine; false specs are not.

## Tab title invariants

When touching `src/zellij/tab-title.ts` and related tests:

- Keep identity, activity, and rendering concerns separated.
- Keep live `running`, `idle`, and `needs-input` status updates.
- Branch display comes from plugin-bound worktree git reads, not from event payloads.
- Unknown or out-of-scope session, status, or input events must not overwrite the visible title.
- Track needs-input state by `(sessionID, requestID)`.
- `TabTitleManager` stays focused on rendering, debounce, retry, and restore — not session activity state.

## PTY and sudo invariants

- Long-lived or interactive work stays in visible Zellij panes.
- `zellij_pty_request_sudo` is human-input-only. Agents must not gain write access.
- Pane cleanup preserves the watchdog-backed path for abnormal OpenCode exits.
