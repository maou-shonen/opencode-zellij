import { afterEach, describe, expect, it } from 'bun:test'
import { assertWriteSizeAllowed, chunkWriteData, maxWriteBytes } from './write-data.js'

const originalMaxWriteBytes = process.env.ZELLIJ_PTY_MAX_WRITE_BYTES

describe('write data helpers', () => {
  afterEach(() => {
    if (originalMaxWriteBytes === undefined) {
      delete process.env.ZELLIJ_PTY_MAX_WRITE_BYTES
    }
    else {
      process.env.ZELLIJ_PTY_MAX_WRITE_BYTES = originalMaxWriteBytes
    }
  })

  it('uses the configured max write size', () => {
    process.env.ZELLIJ_PTY_MAX_WRITE_BYTES = '10'
    expect(maxWriteBytes()).toBe(10)
  })

  it('rejects oversized writes', () => {
    process.env.ZELLIJ_PTY_MAX_WRITE_BYTES = '3'
    expect(() => assertWriteSizeAllowed('abcd')).toThrow(/too large/)
  })

  it('chunks data without splitting multibyte characters', () => {
    expect(chunkWriteData('ab你好cd', 4)).toEqual(['ab', '你', '好c', 'd'])
  })

  it('falls back to the default max write size for invalid configuration', () => {
    process.env.ZELLIJ_PTY_MAX_WRITE_BYTES = 'invalid'
    expect(maxWriteBytes()).toBe(64 * 1024)
  })
})
