import { describe, expect, it } from 'bun:test'
import { RingBuffer } from './ring-buffer.js'

describe('RingBuffer', () => {
  it('keeps only the latest max lines while preserving absolute offsets', () => {
    const buffer = new RingBuffer(3)
    buffer.append(['1', '2', '3', '4'])

    expect(buffer.read({ offset: 0, limit: 10 })).toEqual({
      offset: 1,
      returned: 3,
      lineCount: 4,
      lines: ['2', '3', '4'],
    })
  })

  it('deduplicates overlapping rendered snapshots', () => {
    const buffer = new RingBuffer(10)
    buffer.appendSnapshot(['1', '2', '3'])
    buffer.appendSnapshot(['2', '3', '4'])

    expect(buffer.read({ offset: 0, limit: 10 }).lines).toEqual(['1', '2', '3', '4'])
  })

  it('filters lines and strips ansi by default', () => {
    const buffer = new RingBuffer(10)
    buffer.append(['\u001B[31mError\u001B[0m', 'ok'])

    expect(buffer.read({ grep: 'error', ignoreCase: true }).lines).toEqual(['Error'])
    expect(buffer.read().lines[0]).toBe('Error')
  })

  it('throws on invalid grep regex', () => {
    const buffer = new RingBuffer(10)
    buffer.append(['ok'])

    expect(() => buffer.read({ grep: '[' })).toThrow()
  })

  it('normalizes trailing newline without adding an empty line', () => {
    const buffer = new RingBuffer(10)
    buffer.append('a\nb\n')

    expect(buffer.read({ limit: 10 }).lines).toEqual(['a', 'b'])
  })
})
