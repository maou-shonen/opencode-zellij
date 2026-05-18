import process from 'node:process'
import { describe } from 'bun:test'

// Three-level Zellij target gating:
//   1. hasAnyZellijTarget  — ZELLIJ or ZELLIJ_SESSION_NAME is set
//   2. canRunIntegration   — RUN_ZELLIJ_E2E=1 or RUN_ZELLIJ_INTEGRATION=1 AND target exists
//   3. hasPaneContext       — ZELLIJ && ZELLIJ_PANE_ID (pane-required TUI coverage)
//
// Preflight: fail fast when a RUN_ZELLIJ_* flag is active but no Zellij target
// exists.  This prevents the "0 pass / all skip / 0 fail" silent green.

export const hasAnyZellijTarget = Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME)

if (
  (process.env.RUN_ZELLIJ_E2E === '1' || process.env.RUN_ZELLIJ_INTEGRATION === '1')
  && !hasAnyZellijTarget
) {
  throw new Error(
    'E2E/integration suite requires a Zellij target.\n'
    + '  Set ZELLIJ_SESSION_NAME=my-session to target an existing session.\n'
    + '  For full E2E with TUI coverage, run inside a Zellij pane so that\n'
    + '  ZELLIJ=1, ZELLIJ_PANE_ID=<pane-id>, and ZELLIJ_SESSION_NAME are all set.',
  )
}

export const canRunIntegration = Boolean(
  (process.env.RUN_ZELLIJ_E2E === '1' || process.env.RUN_ZELLIJ_INTEGRATION === '1')
  && hasAnyZellijTarget,
)
export const integration = canRunIntegration ? describe : describe.skip
export const integrationTimeoutMs = 15_000
export const hasPaneContext = Boolean(process.env.ZELLIJ && process.env.ZELLIJ_PANE_ID)
