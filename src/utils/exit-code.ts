import { randomUUID } from 'node:crypto'

export interface ExitCodeMarker {
  token: string
  exitCode: number
}

const markerPattern = /^\[zellij-pty:([a-f0-9]+)\] exit-code=(\d+)$/
const escapeCharacter = String.fromCharCode(27)
const ansiPattern = new RegExp(`${escapeCharacter}\\[[0-9;?]*[a-z]`, 'gi')

export function createExitCodeToken(): string {
  return randomUUID().replaceAll('-', '')
}

export function parseExitCodeMarker(line: string): ExitCodeMarker | null {
  const match = line.replace(ansiPattern, '').trim().match(markerPattern)
  if (!match?.[1] || !match[2])
    return null
  return {
    token: match[1],
    exitCode: Number(match[2]),
  }
}
