import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { inspectSwarmIntegration, reportExitCode } from './check-swarm-integration.mjs'

const roots = []
const prefix = path.join(tmpdir(), 'orca-swarm-integration-')
const packageRoot = 'src/packages/swarm'

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(prefix))) {
      throw new Error('Unexpected fixture path')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(prefix)
  roots.push(root)
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  const git = (...args) => {
    const result = runProcessSync({ program: 'git', args, cwd: root, timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  }
  const commit = (message) => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      message
    )
    return git('rev-parse', 'HEAD')
  }
  write('src/shared/host.ts', 'export const host = 1\n')
  write('src/core.ts', 'export const core = 1\n')
  git('init')
  const baseline = commit('upstream baseline')
  git('checkout', '-b', 'fork')
  write(`${packageRoot}/src/client.ts`, "export { host } from '../../../shared/host'\n")
  write(
    'src/renderer/src/extensions/swarm.ts',
    "export * from '../../../packages/swarm/src/client'\n"
  )
  write(
    `${packageRoot}/integration.json`,
    JSON.stringify({
      version: 1,
      upstreamBase: baseline,
      hostDependencies: ['src/shared/host.ts'],
      entrypoints: { 'src/renderer/src/extensions/swarm.ts': '../../../packages/swarm/src/client' }
    })
  )
  return { root, write, git, commit, baseline }
}

describe('swarm update checks', () => {
  it('rejects new host dependencies, missing entry points and unresolved imports', () => {
    const { root, write } = fixture()
    expect(reportExitCode(inspectSwarmIntegration(root))).toBe(0)
    write(`${packageRoot}/src/extra.ts`, "import { core } from '../../../core'\nexport { core }\n")
    expect(inspectSwarmIntegration(root).errors).toContain(
      'Unreviewed host dependency: src/core.ts'
    )
    write('src/renderer/src/extensions/swarm.ts', 'export {}\n')
    expect(
      inspectSwarmIntegration(root).errors.some((error) =>
        error.startsWith('Missing extension entry point')
      )
    ).toBe(true)
    write(`${packageRoot}/src/extra.ts`, "export * from './missing'\n")
    expect(() => inspectSwarmIntegration(root)).toThrow('Cannot resolve')
  })

  it('detects upstream overlap, host changes and package collisions without changing the checkout', () => {
    const { root, write, git, commit, baseline } = fixture()
    write('src/core.ts', 'export const core = 2\n')
    const fork = commit('fork changes')
    git('checkout', '-b', 'candidate', baseline)
    write('src/shared/host.ts', 'export const host = 3\n')
    write('src/core.ts', 'export const core = 3\n')
    write(`${packageRoot}/upstream.txt`, 'new upstream package\n')
    const candidate = commit('upstream changes')
    git('checkout', 'fork')
    const original = readFileSync(path.join(root, 'src/core.ts'), 'utf8')
    const report = inspectSwarmIntegration(root, { upstream: candidate })
    expect(reportExitCode(report)).toBe(2)
    expect(report.upstream.coreOverlaps).toEqual(['src/core.ts'])
    expect(report.upstream.hostChanges).toEqual(['src/shared/host.ts'])
    expect(report.upstream.packageCollisions).toEqual([`${packageRoot}/upstream.txt`])
    expect(git('rev-parse', 'HEAD')).toBe(fork)
    expect(git('status', '--porcelain')).toBe('')
    expect(readFileSync(path.join(root, 'src/core.ts'), 'utf8')).toBe(original)
  })

  it('accepts unrelated upstream edits and fails closed for missing revisions', () => {
    const { root, write, git, commit, baseline } = fixture()
    commit('extension')
    git('checkout', '-b', 'candidate', baseline)
    write('README.md', 'unrelated upstream docs\n')
    const candidate = commit('docs')
    git('checkout', 'fork')
    expect(reportExitCode(inspectSwarmIntegration(root, { upstream: candidate }))).toBe(0)
    expect(() => inspectSwarmIntegration(root, { upstream: 'missing-ref' })).toThrow()
    expect(() => inspectSwarmIntegration(root, { upstream: '--help' })).toThrow('Invalid revision')
  })
})
