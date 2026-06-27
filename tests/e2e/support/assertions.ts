import { zellij } from '../../../src/lib/zellij/cli.js'

export async function waitForTabTitle(
  predicate: (title: string | undefined) => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const intervalMs = 250
  const maxAttempts = Math.floor(timeoutMs / intervalMs)
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    try {
      const title = await zellij.currentTabTitle()
      if (predicate(title))
        return true
    }
    catch {
      // keep polling
    }
  }
  return false
}

export async function waitForTabTitleValue(
  predicate: (title: string | undefined) => boolean,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const intervalMs = 250
  const maxAttempts = Math.floor(timeoutMs / intervalMs)
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    try {
      const title = await zellij.currentTabTitle()
      if (predicate(title))
        return title
    }
    catch {
      // keep polling
    }
  }
  return undefined
}

export type StableTabTitleExpectation = string | ((title: string | undefined) => boolean)

export interface StableTabTitleObservation {
  ok: boolean
  title?: string
  failure?: string
}

export interface StableTabTitleOptions {
  expected: StableTabTitleExpectation
  forbidden?: (title: string | undefined) => boolean
  timeoutMs?: number
  stabilityMs?: number
  intervalMs?: number
}

export async function observeStableTabTitle({
  expected,
  forbidden,
  timeoutMs = 5_000,
  stabilityMs = 1_000,
  intervalMs = 250,
}: StableTabTitleOptions): Promise<StableTabTitleObservation> {
  let matchesExpected: (title: string | undefined) => boolean
  if (typeof expected === 'string') {
    matchesExpected = title => title === expected
  }
  else {
    matchesExpected = expected
  }

  const withTitle = (result: StableTabTitleObservation, title: string | undefined) =>
    title === undefined ? result : { ...result, title }

  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  const deadline = Date.now() + timeoutMs
  let stableSince: number | undefined
  let stableTitle: string | undefined

  while (Date.now() < deadline) {
    await sleep(intervalMs)

    let title: string | undefined
    try {
      title = await zellij.currentTabTitle()
    }
    catch {
      continue
    }

    if (forbidden?.(title))
      return withTitle({ ok: false, failure: 'Forbidden tab title observed' }, title)

    if (!matchesExpected(title)) {
      if (stableSince !== undefined) {
        return withTitle({
          ok: false,
          failure: 'Expected tab title changed before the stability window completed',
        }, title)
      }

      continue
    }

    stableSince ??= Date.now()
    stableTitle = title

    if (Date.now() - stableSince >= stabilityMs)
      return withTitle({ ok: true }, stableTitle)
  }

  if (stableSince !== undefined) {
    return withTitle({
      ok: false,
      failure: 'Expected tab title did not stay stable long enough',
    }, stableTitle)
  }

  return {
    ok: false,
    failure: 'Expected tab title was not observed',
  }
}
