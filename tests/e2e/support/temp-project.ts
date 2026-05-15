import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_PROJECT_CONFIG = '{ "tabTitle": { "enabled": true }, "autoUpdate": false }'

interface TempProjectOptions {
  configContent?: string
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return result.stdout ?? ''
}

export async function writeProjectConfig(projectRoot: string, configContent: string = DEFAULT_PROJECT_CONFIG): Promise<void> {
  const configDir = join(projectRoot, '.opencode')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'opencode-zellij.config.jsonc'), configContent)
}

export async function withTempGitProject<T>(run: (projectRoot: string) => Promise<T>, options: TempProjectOptions = {}): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-e2e-'))
  const projectRoot = join(tempRoot, 'project')
  await mkdir(projectRoot, { recursive: true })

  try {
    await runGit(['init', '-b', 'main'], projectRoot)
    await runGit(['config', 'user.email', 'integration@example.com'], projectRoot)
    await runGit(['config', 'user.name', 'Integration'], projectRoot)
    await runGit(['commit', '--allow-empty', '-m', 'init'], projectRoot)
    await writeProjectConfig(projectRoot, options.configContent)
    return await run(projectRoot)
  }
  finally {
    await rm(tempRoot, { force: true, recursive: true })
  }
}
