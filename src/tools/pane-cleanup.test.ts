import { describe, expect, it } from 'bun:test'
import { closePaneOrVerifyGone } from './pane-cleanup.js'

describe('closePaneOrVerifyGone', () => {
  it('treats a successful close as cleanup-ready', async () => {
    const result = await closePaneOrVerifyGone({
      paneId: 'terminal_1',
      closePane: async () => {},
      paneExists: async () => true,
    })

    expect(result).toEqual({ cleanupReady: true, alreadyGone: false })
  })

  it('treats a failed close with absent pane as cleanup-ready', async () => {
    const result = await closePaneOrVerifyGone({
      paneId: 'terminal_2',
      closePane: async () => {
        throw new Error('close failed')
      },
      paneExists: async () => false,
    })

    expect(result).toEqual({ cleanupReady: true, alreadyGone: true, closeErrorMessage: 'close failed' })
  })

  it('keeps cleanup blocked when verification is unknown', async () => {
    const result = await closePaneOrVerifyGone({
      paneId: 'terminal_3',
      closePane: async () => {
        throw new Error('close failed')
      },
      paneExists: async () => undefined,
    })

    expect(result).toEqual({ cleanupReady: false, alreadyGone: false, closeErrorMessage: 'close failed' })
  })
})
