import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAndUpdate,
  findInstallContext,
  isAutoUpdatableSpec,
  PACKAGE_NAME,
  runNpmInstall,
  type ExecFileLike,
} from './auto-update.js'

function mockFetch(response: Response, onCall?: () => void): typeof fetch {
  const fn = Object.assign(
    () => {
      onCall?.()
      return Promise.resolve(response)
    },
    { preconnect: () => Promise.resolve() },
  )
  return fn as unknown as typeof fetch
}

async function createCachedInstall(tempRoot: string, cacheSpec: string, version: string): Promise<{ installRoot: string, moduleUrl: string }> {
  const installRoot = join(tempRoot, 'opencode-cache', 'packages', cacheSpec)
  const pluginDir = join(installRoot, 'node_modules', PACKAGE_NAME, 'dist')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(installRoot, 'package.json'), JSON.stringify({ dependencies: { [PACKAGE_NAME]: version } }))
  await writeFile(join(pluginDir, '..', 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }))
  await writeFile(join(pluginDir, 'index.mjs'), '')
  return { installRoot, moduleUrl: `file://${pluginDir}/auto-update.mjs` }
}

describe('auto-update', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-autoupdate-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true })
  })

  describe('findInstallContext', () => {
    it('returns undefined for local development paths', async () => {
      const result = await findInstallContext(import.meta.url)

      expect(result).toBeUndefined()
    })

    it('returns install root, cache spec, and version for cached plugin installs', async () => {
      const install = await createCachedInstall(tempRoot, `${PACKAGE_NAME}@latest`, '0.0.2')

      const result = await findInstallContext(install.moduleUrl)

      expect(result).toEqual({
        installRoot: install.installRoot,
        cacheSpec: `${PACKAGE_NAME}@latest`,
        currentVersion: '0.0.2',
      })
    })

    it('returns undefined when install root package.json is missing', async () => {
      const installRoot = join(tempRoot, 'opencode-cache', 'packages', `${PACKAGE_NAME}@latest`)
      const pluginDir = join(installRoot, 'node_modules', PACKAGE_NAME, 'dist')
      await mkdir(pluginDir, { recursive: true })
      await writeFile(join(pluginDir, '..', 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.2' }))

      const result = await findInstallContext(`file://${pluginDir}/auto-update.mjs`)

      expect(result).toBeUndefined()
    })
  })

  describe('isAutoUpdatableSpec', () => {
    it('allows bare package name and @latest', () => {
      expect(isAutoUpdatableSpec(PACKAGE_NAME)).toBe(true)
      expect(isAutoUpdatableSpec(`${PACKAGE_NAME}@latest`)).toBe(true)
    })

    it('rejects pinned versions, ranges, dist-tags, unrelated, malformed, and missing specs', () => {
      expect(isAutoUpdatableSpec(`${PACKAGE_NAME}@0.0.2`)).toBe(false)
      expect(isAutoUpdatableSpec(`${PACKAGE_NAME}@^0.0.2`)).toBe(false)
      expect(isAutoUpdatableSpec(`${PACKAGE_NAME}@beta`)).toBe(false)
      expect(isAutoUpdatableSpec(`${PACKAGE_NAME}@next`)).toBe(false)
      expect(isAutoUpdatableSpec('some-other-plugin')).toBe(false)
      expect(isAutoUpdatableSpec('')).toBe(false)
      expect(isAutoUpdatableSpec(undefined)).toBe(false)
    })
  })

  describe('runNpmInstall', () => {
    it('returns true when exec succeeds', async () => {
      const installRoot = join(tempRoot, 'cache', `${PACKAGE_NAME}@latest`)
      const packageDir = join(installRoot, 'node_modules', PACKAGE_NAME)
      const execImpl: ExecFileLike = async () => {
        await mkdir(join(packageDir, 'dist'), { recursive: true })
        await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.3' }))
        await writeFile(join(packageDir, 'dist', 'index.mjs'), '')
        return { stdout: '', stderr: '' }
      }

      const result = await runNpmInstall(installRoot, '0.0.3', execImpl)

      expect(result).toBe(true)
    })

    it('returns false when exec throws', async () => {
      const execImpl: ExecFileLike = async () => {
        throw new Error('npm failed')
      }

      const result = await runNpmInstall('/some/root', '0.0.3', execImpl)

      expect(result).toBe(false)
    })

    it('passes the safe update command to exec', async () => {
      let capturedArgs: string[] = []
      let capturedCwd = ''
      const execImpl: ExecFileLike = async (file, args, options) => {
        capturedArgs = [file, ...args]
        capturedCwd = options.cwd
        return { stdout: '', stderr: '' }
      }

      await runNpmInstall('/project/root', '0.0.5', execImpl)

      expect(capturedCwd).toBe('/project/root')
      expect(capturedArgs).toEqual([
        'npm',
        'install',
        `${PACKAGE_NAME}@0.0.5`,
        '--save-exact',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefer-online',
      ])
    })

    it('removes and reinstalls a stale package directory when npm reports success but files stay old', async () => {
      const installRoot = join(tempRoot, 'cache', `${PACKAGE_NAME}@latest`)
      const packageDir = join(installRoot, 'node_modules', PACKAGE_NAME)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.4' }))

      let calls = 0
      const execImpl: ExecFileLike = async () => {
        calls += 1
        if (calls === 2) {
          await mkdir(join(packageDir, 'dist'), { recursive: true })
          await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.5' }))
          await writeFile(join(packageDir, 'dist', 'index.mjs'), '')
        }
        return { stdout: '', stderr: '' }
      }

      const result = await runNpmInstall(installRoot, '0.0.5', execImpl)

      expect(result).toBe(true)
      expect(calls).toBe(2)
      expect(JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version).toBe('0.0.5')
    })

    it('returns false when reinstall still leaves a stale package version', async () => {
      const installRoot = join(tempRoot, 'cache', `${PACKAGE_NAME}@latest`)
      const packageDir = join(installRoot, 'node_modules', PACKAGE_NAME)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.4' }))

      let calls = 0
      const execImpl: ExecFileLike = async () => {
        calls += 1
        await mkdir(packageDir, { recursive: true })
        await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.4' }))
        return { stdout: '', stderr: '' }
      }

      const result = await runNpmInstall(installRoot, '0.0.5', execImpl)

      expect(result).toBe(false)
      expect(calls).toBe(2)
    })

    it('returns false when reinstall leaves an unexpected package name', async () => {
      const installRoot = join(tempRoot, 'cache', `${PACKAGE_NAME}@latest`)
      const packageDir = join(installRoot, 'node_modules', PACKAGE_NAME)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.4' }))

      const execImpl: ExecFileLike = async () => {
        await mkdir(packageDir, { recursive: true })
        await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'other-package', version: '0.0.5' }))
        return { stdout: '', stderr: '' }
      }

      await expect(runNpmInstall(installRoot, '0.0.5', execImpl)).resolves.toBe(false)
    })

    it('restores the previous package when forced reinstall fails', async () => {
      const installRoot = join(tempRoot, 'cache', `${PACKAGE_NAME}@latest`)
      const packageDir = join(installRoot, 'node_modules', PACKAGE_NAME)
      await mkdir(join(packageDir, 'dist'), { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.4' }))
      await writeFile(join(packageDir, 'dist', 'index.mjs'), 'old')

      let calls = 0
      const execImpl: ExecFileLike = async () => {
        calls += 1
        if (calls === 2)
          throw new Error('npm failed')
        return { stdout: '', stderr: '' }
      }

      await expect(runNpmInstall(installRoot, '0.0.5', execImpl)).resolves.toBe(false)
      expect(calls).toBe(2)
      expect(JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version).toBe('0.0.4')
      expect(await readFile(join(packageDir, 'dist', 'index.mjs'), 'utf8')).toBe('old')
    })
  })

  describe('checkAndUpdate', () => {
    it('returns skipped when not installed from npm cache', async () => {
      let fetchCalled = false
      let execCalled = false

      const result = await checkAndUpdate({
        importMetaUrl: import.meta.url,
        fetchImpl: mockFetch(new Response('{}'), () => { fetchCalled = true }),
        execImpl: async () => {
          execCalled = true
          return { stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ type: 'skipped', reason: 'not installed from npm' })
      expect(fetchCalled).toBe(false)
      expect(execCalled).toBe(false)
    })

    it('returns skipped for pinned cache specs', async () => {
      for (const cacheSpec of [`${PACKAGE_NAME}@0.0.1`, `${PACKAGE_NAME}@^0.0.1`, `${PACKAGE_NAME}@beta`, `${PACKAGE_NAME}@next`, 'unknown-package@latest']) {
        const install = await createCachedInstall(tempRoot, cacheSpec, '0.0.1')
        let fetchCalled = false
        let execCalled = false

        const result = await checkAndUpdate({
          importMetaUrl: install.moduleUrl,
          fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 }), () => { fetchCalled = true }),
          execImpl: async () => {
            execCalled = true
            return { stdout: '', stderr: '' }
          },
        })

        expect(result).toEqual({ type: 'skipped', reason: `cache spec is pinned or unknown (${cacheSpec})` })
        expect(fetchCalled).toBe(false)
        expect(execCalled).toBe(false)
      }
    })

    it('returns up-to-date when already on latest version', async () => {
      const install = await createCachedInstall(tempRoot, `${PACKAGE_NAME}@latest`, '0.0.5')
      let execCalled = false

      const result = await checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 })),
        execImpl: async () => {
          execCalled = true
          return { stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ type: 'up-to-date', currentVersion: '0.0.5' })
      expect(execCalled).toBe(false)
    })

    it('returns updated for @latest cache specs', async () => {
      const install = await createCachedInstall(tempRoot, `${PACKAGE_NAME}@latest`, '0.0.1')
      const packageJson = join(install.installRoot, 'node_modules', PACKAGE_NAME, 'package.json')
      let execCalled = false

      const result = await checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 })),
        execImpl: async () => {
          execCalled = true
          await mkdir(join(install.installRoot, 'node_modules', PACKAGE_NAME, 'dist'), { recursive: true })
          await writeFile(packageJson, JSON.stringify({ name: PACKAGE_NAME, version: '0.0.5' }))
          await writeFile(join(install.installRoot, 'node_modules', PACKAGE_NAME, 'dist', 'index.mjs'), '')
          return { stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ type: 'updated', fromVersion: '0.0.1', toVersion: '0.0.5' })
      expect(execCalled).toBe(true)
    })

    it('returns updated for bare package cache specs', async () => {
      const install = await createCachedInstall(tempRoot, PACKAGE_NAME, '0.0.1')
      const packageJson = join(install.installRoot, 'node_modules', PACKAGE_NAME, 'package.json')
      let execCalled = false

      const result = await checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 })),
        execImpl: async () => {
          execCalled = true
          await mkdir(join(install.installRoot, 'node_modules', PACKAGE_NAME, 'dist'), { recursive: true })
          await writeFile(packageJson, JSON.stringify({ name: PACKAGE_NAME, version: '0.0.5' }))
          await writeFile(join(install.installRoot, 'node_modules', PACKAGE_NAME, 'dist', 'index.mjs'), '')
          return { stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ type: 'updated', fromVersion: '0.0.1', toVersion: '0.0.5' })
      expect(execCalled).toBe(true)
    })

    it('returns skipped when fetching the latest version fails', async () => {
      const install = await createCachedInstall(tempRoot, `${PACKAGE_NAME}@latest`, '0.0.1')
      let execCalled = false

      const result = await checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response('error', { status: 500 })),
        execImpl: async () => {
          execCalled = true
          return { stdout: '', stderr: '' }
        },
      })

      expect(result).toEqual({ type: 'skipped', reason: 'could not determine latest version' })
      expect(execCalled).toBe(false)
    })

    it('returns failed when npm install throws', async () => {
      const install = await createCachedInstall(tempRoot, `${PACKAGE_NAME}@latest`, '0.0.1')

      const result = await checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 })),
        execImpl: async () => {
          throw new Error('npm failed')
        },
      })

      expect(result).toEqual({ type: 'failed', currentVersion: '0.0.1', latestVersion: '0.0.5', reason: 'npm install failed' })
    })

    it('skips concurrent updates for the same install root', async () => {
      const install = await createCachedInstall(tempRoot, `${PACKAGE_NAME}@latest`, '0.0.1')
      const packageDir = join(install.installRoot, 'node_modules', PACKAGE_NAME)
      let installCalls = 0
      let releaseInstall: (() => void) | undefined
      const execImpl: ExecFileLike = async () => {
        installCalls += 1
        await new Promise<void>((resolve) => {
          releaseInstall = resolve
        })
        await mkdir(join(packageDir, 'dist'), { recursive: true })
        await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.5' }))
        await writeFile(join(packageDir, 'dist', 'index.mjs'), '')
        return { stdout: '', stderr: '' }
      }

      const first = checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 })),
        execImpl,
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      const second = await checkAndUpdate({
        importMetaUrl: install.moduleUrl,
        fetchImpl: mockFetch(new Response(JSON.stringify({ latest: '0.0.5' }), { status: 200 })),
        execImpl,
      })
      releaseInstall?.()

      expect(await first).toEqual({ type: 'updated', fromVersion: '0.0.1', toVersion: '0.0.5' })
      expect(second).toEqual({ type: 'skipped', reason: 'update already in progress' })
      expect(installCalls).toBe(1)
    })
  })
})
