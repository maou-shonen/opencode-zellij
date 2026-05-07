import { sessionManager } from '../pty/manager.js'
import { subscriberManager } from '../zellij/subscribe.js'

export interface OutputSnapshot {
  text: string
  lines: string[]
  lineCount: number
  returned: number
  truncated: boolean
}

export function emptyOutputSnapshot(lineCount = 0): OutputSnapshot {
  return { text: '', lines: [], lineCount, returned: 0, truncated: false }
}

export interface OutputOptions {
  maxLines?: number | undefined
  grep?: string | undefined
  ignoreCase?: boolean | undefined
}

export function validateGrep(grep: string | undefined): string | null {
  if (!grep)
    return null
  try {
    new RegExp(grep).test('')
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function readOutputSnapshot(sessionId: string, options: OutputOptions = {}): OutputSnapshot {
  const grepError = validateGrep(options.grep)
  if (grepError)
    throw new Error(`Invalid grep regex: ${grepError}`)

  const buffered = subscriberManager.read(sessionId, {
    limit: options.maxLines,
    grep: options.grep,
    ignoreCase: options.ignoreCase,
  })
  sessionManager.updateLineCount(sessionId, buffered.lineCount)

  return {
    text: buffered.lines.join('\n'),
    lines: buffered.lines,
    lineCount: buffered.lineCount,
    returned: buffered.returned,
    truncated: buffered.offset > 0,
  }
}

export function outputMatches(sessionId: string, grep: string, ignoreCase?: boolean | undefined): boolean {
  return readOutputSnapshot(sessionId, { maxLines: 5_000, grep, ignoreCase }).returned > 0
}
