import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { parsePaneId } from '../../src/utils/ids.js'
import { runZellij, listPanes } from './support/zellij.js'

// ---------------------------------------------------------------------------
// Single integration-style case that replaces the old scripts-based CI pane
// runner.  Creates a live Zellij pane, runs pane-internal full E2E, collects
// pane log and result JSON, then asserts pane env id matches created pane id
// and exit code is 0.
//
// The pane payload is a short inline bash script (temp file) with positional
// args so quoting stays clean.  CI_PANE_INNER_COMMAND can override the inner
// command for negative-test failure injection.
// ---------------------------------------------------------------------------

const innerCommand = process.env.CI_PANE_INNER_COMMAND ?? 'mise run test-e2e'
const paneTimeoutMs = Number(process.env.CI_PANE_TIMEOUT_MS ?? 480_000)

describe('CI pane orchestration', () => {
  it('runs full e2e inside a live Zellij pane and validates pane context', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'opencode-zellij-ci-pane-'))
    const resultFile = join(tmpDir, 'result.json')
    const paneLog = join(tmpDir, 'pane.log')
    const innerScript = join(tmpDir, 'ci-pane-inner.sh')

    let createdPaneId: string | undefined

    try {
      // ── write the pane-inner shell script ──────────────────────────
      // Uses positional args: $1 = paneLog, $2 = resultFile.
      // Sourced via plain `bash <script> <args>` (no -lc needed).
      //
      // NOTE: exec > >(tee ...) + subshell breakout is avoided here.
      // Instead each important line is explicitly tee'd so the pane log
      // reliably captures script progress even if the pane exits abruptly
      // after the inner command finishes.
      await writeFile(innerScript, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        'pane_log="$1"',
        'result_file="$2"',
        '',
        'log() { printf "%s\\n" "$*" | tee -a "$pane_log"; }',
        '',
        // Stamp pane env id before any inner command runs
        'log "[ci-pane] pane_env_id=$ZELLIJ_PANE_ID"',
        '',
        // Run the inner command, capturing both stdout and stderr to the pane log
        '(',
        innerCommand,
        ') 2>&1 | tee -a "$pane_log"',
        'rc="${PIPESTATUS[0]}"',
        '',
        'log "[ci-pane] exit_code=$rc"',
        '',
        // Write result JSON — use printf to avoid heredoc edge cases
        'printf \'{"exitCode":%s,"paneEnvId":"%s"}\\n\' "$rc" "${ZELLIJ_PANE_ID:-}" > "$result_file"',
        '',
        // Sync before exit to ensure the result file is flushed
        'sync',
        'exit "$rc"',
      ].join('\n'))

      // ── create the pane via zellij action ──────────────────────────
      const cwd = process.env.GITHUB_WORKSPACE?.trim() || process.cwd()
      const spawnOutput = await runZellij([
        'action', 'new-pane',
        '--name', `ci-pane-${Date.now()}`,
        '--cwd', cwd,
        '--',
        'bash', innerScript, paneLog, resultFile,
      ], 10_000)

      createdPaneId = parsePaneId(spawnOutput)
      expect(createdPaneId).toBeDefined()
      if (!createdPaneId) {
        throw new Error(`Could not parse pane ID from new-pane output: ${JSON.stringify(spawnOutput)}`)
      }
      console.log(`Created CI pane: ${createdPaneId}`)

      // ── poll for result file ───────────────────────────────────────
      const deadline = Date.now() + paneTimeoutMs
      let resultFound = false

      while (Date.now() <= deadline) {
        try {
          const content = await readFile(resultFile, 'utf8')
          if (content.trim().length > 0) {
            resultFound = true
            break
          }
        }
        catch {
          // file not yet written
        }

        // Check that the created pane still exists
        const panes = await listPanes()
        const paneAlive = panes.some(
          p =>
            normalizePaneId(p.id) === createdPaneId
            || normalizePaneId(p.pane_id) === createdPaneId,
        )

        if (!paneAlive) {
          // Brief grace period in case result was written between checks
          await new Promise(r => setTimeout(r, 500))
          try {
            const content = await readFile(resultFile, 'utf8')
            if (content.trim().length > 0) {
              resultFound = true
              break
            }
          }
          catch {
            // swallow
          }
          throw new Error(
            `Pane ${createdPaneId} disappeared before writing result\n`
            + `  raw new-pane output: ${JSON.stringify(spawnOutput)}`,
          )
        }

        await new Promise(r => setTimeout(r, 1_000))
      }

      if (!resultFound) {
        throw new Error(
          `Timed out after ${paneTimeoutMs}ms waiting for pane ${createdPaneId} to finish`,
        )
      }

      // ── parse and validate result ──────────────────────────────────
      const resultRaw = await readFile(resultFile, 'utf8')
      let result: { exitCode: unknown; paneEnvId: unknown }
      try {
        result = JSON.parse(resultRaw)
      }
      catch {
        throw new Error(`Invalid result JSON: ${resultRaw.trim() || '<empty>'}`)
      }

      expect(result.paneEnvId).toBeDefined()
      expect(typeof result.paneEnvId).toBe('string')
      expect((result.paneEnvId as string).trim()).not.toBe('')

      const normalizedPaneEnvId = normalizePaneId(result.paneEnvId as string)
      expect(normalizedPaneEnvId).toBe(createdPaneId)

      expect(result.exitCode).toBeDefined()
      expect(typeof result.exitCode).toBe('number')
      expect(Number.isInteger(result.exitCode)).toBe(true)
      expect(result.exitCode).toBe(0)

      console.log(`CI pane ${createdPaneId} completed with exit code ${result.exitCode}`)
    }
    finally {
      // ── always print pane log for debugging ───────────────────────
      console.log('::group::CI pane E2E log')
      try {
        const log = await readFile(paneLog, 'utf8')
        process.stdout.write(log || '<pane log empty>\n')
      }
      catch {
        console.log('<pane log not found>')
      }
      console.log('::endgroup::')

      await rm(tmpDir, { force: true, recursive: true })
    }
  }, paneTimeoutMs + 10_000)
})

// ---------------------------------------------------------------------------
// File-local helpers (replaces the exported functions from old runner)
// ---------------------------------------------------------------------------

function normalizePaneId(value: number | string | undefined): string | undefined {
  if (value === undefined)
    return undefined

  const normalized = String(value).trim()
  if (!normalized)
    return undefined

  if (/^terminal_\d+$/.test(normalized))
    return normalized

  if (/^\d+$/.test(normalized))
    return `terminal_${normalized}`

  return normalized
}
