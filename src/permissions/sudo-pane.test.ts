import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { assertSudoPaneAllowed, configureSudoPane } from './sudo-pane.js'

describe('sudo pane permissions', () => {
  beforeEach(() => configureSudoPane(true))
  afterEach(() => configureSudoPane(true))

  it('allows sudo panes by default', () => {
    expect(() => assertSudoPaneAllowed()).not.toThrow()
  })

  it('can disable sudo panes', () => {
    configureSudoPane(false)
    expect(() => assertSudoPaneAllowed()).toThrow(/sudo pane is disabled/)
  })
})
