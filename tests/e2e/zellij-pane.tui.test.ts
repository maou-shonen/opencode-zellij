import { describe, it } from 'bun:test'
import { canRunIntegration, hasPaneContext } from './support/env.js'

const paneTui = canRunIntegration && hasPaneContext ? describe : describe.skip

paneTui('real Zellij pane TUI integration', () => {
  it.skip('placeholder for future pane-specific TUI coverage', () => {})
})
