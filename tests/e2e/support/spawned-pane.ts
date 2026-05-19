import { parsePaneId } from '../../../src/utils/ids.js'

export interface SpawnedTerminalPaneIdentity {
  normalizedPaneId: string
  numericPaneId: number
}

interface VerifySpawnedTerminalPaneIdentityOptions {
  spawnOutput: string
  currentPaneId?: string | undefined
  paneIdsBeforeSpawn?: ReadonlySet<number>
}

export function verifySpawnedTerminalPaneIdentity({
  spawnOutput,
  currentPaneId,
  paneIdsBeforeSpawn,
}: VerifySpawnedTerminalPaneIdentityOptions): SpawnedTerminalPaneIdentity {
  const trimmedCurrentPaneId = currentPaneId?.trim() || undefined

  let normalizedPaneId: string
  try {
    normalizedPaneId = parsePaneId(spawnOutput)
  }
  catch (error) {
    throw createSpawnedPaneIdentityError({
      spawnOutput,
      currentPaneId: trimmedCurrentPaneId,
      reason: error instanceof Error
        ? error.message
        : 'Unable to parse Zellij pane id from new-pane output',
    })
  }

  const numericPaneId = terminalPaneNumber(normalizedPaneId)
  if (numericPaneId === undefined) {
    throw createSpawnedPaneIdentityError({
      spawnOutput,
      currentPaneId: trimmedCurrentPaneId,
      parsedPaneId: normalizedPaneId,
      reason: 'Parsed pane id was not a terminal pane id',
    })
  }

  const currentPaneNumeric = terminalPaneNumber(trimmedCurrentPaneId)
  if (currentPaneNumeric !== undefined && numericPaneId === currentPaneNumeric) {
    throw createSpawnedPaneIdentityError({
      spawnOutput,
      currentPaneId: trimmedCurrentPaneId,
      parsedPaneId: normalizedPaneId,
      reason: 'Parsed pane id matches the current/outer pane id',
    })
  }

  if (paneIdsBeforeSpawn?.has(numericPaneId)) {
    throw createSpawnedPaneIdentityError({
      spawnOutput,
      currentPaneId: trimmedCurrentPaneId,
      parsedPaneId: normalizedPaneId,
      reason: 'Parsed pane id already existed before spawn, so the new terminal pane is not safely identifiable',
    })
  }

  return {
    normalizedPaneId,
    numericPaneId,
  }
}

function terminalPaneNumber(rawPaneId: string | undefined): number | undefined {
  if (!rawPaneId)
    return undefined

  const trimmed = rawPaneId.trim()
  if (/^terminal_\d+$/.test(trimmed))
    return Number(trimmed.slice('terminal_'.length))
  if (/^\d+$/.test(trimmed))
    return Number(trimmed)
  return undefined
}

function createSpawnedPaneIdentityError({
  spawnOutput,
  currentPaneId,
  parsedPaneId,
  reason,
}: {
  spawnOutput: string
  currentPaneId?: string | undefined
  parsedPaneId?: string | undefined
  reason: string
}): Error {
  return new Error(
    'Spawn output could not be safely identified as a new terminal pane.\n'
    + `  reason: ${reason}\n`
    + `  raw new-pane output: ${JSON.stringify(spawnOutput)}\n`
    + `  current pane id: ${JSON.stringify(currentPaneId ?? '<missing>')}\n`
    + `  parsed pane id: ${JSON.stringify(parsedPaneId ?? '<unparsed>')}`,
  )
}
