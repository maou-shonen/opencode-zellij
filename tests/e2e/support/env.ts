import process from 'node:process'
import { describe } from 'bun:test'

export const canRunIntegration = Boolean((process.env.RUN_ZELLIJ_E2E === '1' || process.env.RUN_ZELLIJ_INTEGRATION === '1') && (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME))
export const integration = canRunIntegration ? describe : describe.skip
export const integrationTimeoutMs = 15_000
export const hasPaneContext = Boolean(process.env.ZELLIJ && process.env.ZELLIJ_PANE_ID)
