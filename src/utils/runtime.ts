import process from 'node:process'

/**
 * Detect whether the plugin process is running inside an OpenCode TUI
 * session, as opposed to a headless `opencode run` invocation.
 *
 * OpenCode spawns the TUI's renderer as a worker child process and
 * explicitly sets `OPENCODE_PROCESS_ROLE=worker`
 * (see `packages/opencode/src/cli/cmd/tui/thread.ts` in opencode). The
 * headless `opencode run` command keeps the default `main` role set by
 * the CLI entry point, so this is the most reliable signal to tell TUI
 * from headless.
 *
 * Outside the TUI there is no surface for toasts, prompts, or Zellij
 * panes, and the plugin's lifecycle hooks (watchdogs, tab title actor,
 * completion notifications) misbehave. The plugin short-circuits to a
 * no-op in headless mode to avoid leaking side effects.
 */
export function isOpencodeTuiMode(): boolean {
  return process.env.OPENCODE_PROCESS_ROLE === 'worker'
}
