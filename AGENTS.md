# AGENTS.md

## Tasks

!`mise tasks --local`

`mise run check` is the fast in-process validation. `mise run test-e2e` is the high-fidelity E2E. Run both when adding or modifying features.

## README as spec

README.md is the spec; tests are the source of truth. Every tool, feature, and config option is bound to a top-level `describe(...)` via the section's `**Spec:**` link. `mise run check` runs `lint:readme` and fails on dead links.

When adding or modifying a feature:

1. Add or update the `describe` group.
2. Update the `**Spec:**` link in README, in the same commit. A `describe` rename is breaking.
3. Run `mise run check`.

Helper-only files under `tests/**/support/` are not specs.

## Style

- TypeScript ESM, no-semicolon.
- Tests: `describe` reads as section heading, `it` as behavior clause.
