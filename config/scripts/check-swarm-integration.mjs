import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

const PACKAGE_ROOT = 'src/packages/swarm'
const slash = (file) => file.split(path.sep).join('/')

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(file)
    }
    return /\.tsx?$/.test(file) && !isTestOnlySourcePath(file) ? [file] : []
  })
}

function localModule(root, file, specifier) {
  const base = specifier.startsWith('@/')
    ? path.join(root, 'src/renderer/src', specifier.slice(2))
    : specifier.startsWith('@renderer/')
      ? path.join(root, 'src/renderer/src', specifier.slice(10))
      : specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier)
        : null
  if (!base) {
    return null
  }
  for (const suffix of ['', '.ts', '.tsx', '.json', '/index.ts', '/index.tsx']) {
    const candidate = base + suffix
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const relative = slash(path.relative(root, candidate))
      if (relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error(`Import escapes the checkout: ${specifier}`)
      }
      return relative
    }
  }
  throw new Error(`Cannot resolve ${specifier} in ${slash(path.relative(root, file))}`)
}

export function collectSwarmHostDependencies(root) {
  const dependencies = new Set()
  for (const file of sourceFiles(path.join(root, PACKAGE_ROOT, 'src'))) {
    for (const specifier of collectModuleSpecifiers(file, readFileSync(file, 'utf8'))) {
      const resolved = localModule(root, file, specifier)
      if (resolved && !resolved.startsWith(`${PACKAGE_ROOT}/`)) {
        dependencies.add(resolved)
      }
    }
  }
  return [...dependencies].sort()
}

function git(root, args) {
  const result = runProcessSync({
    program: 'git',
    args,
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024
  })
  if (result.code !== 0) {
    throw new Error(result.stderr || `git ${args[0]} failed`)
  }
  return result.stdout
}

function revision(root, ref) {
  if (!ref || ref.startsWith('-') || /\s/.test(ref) || ref.includes('\0')) {
    throw new Error('Invalid revision')
  }
  return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
}

export function inspectSwarmIntegration(root, { upstream } = {}) {
  const manifest = JSON.parse(
    readFileSync(path.join(root, PACKAGE_ROOT, 'integration.json'), 'utf8')
  )
  if (manifest.version !== 1) {
    throw new Error('Unsupported Swarm integration manifest version')
  }
  const hostDependencies = collectSwarmHostDependencies(root)
  const errors = []
  for (const file of hostDependencies) {
    if (!manifest.hostDependencies.includes(file)) {
      errors.push(`Unreviewed host dependency: ${file}`)
    }
  }
  for (const file of manifest.hostDependencies) {
    if (!hostDependencies.includes(file)) {
      errors.push(`Stale host dependency: ${file}`)
    }
  }
  for (const [file, requiredImport] of Object.entries(manifest.entrypoints)) {
    const absolute = path.join(root, file)
    if (
      !existsSync(absolute) ||
      !collectModuleSpecifiers(absolute, readFileSync(absolute, 'utf8')).includes(requiredImport)
    ) {
      errors.push(`Missing extension entry point: ${file} -> ${requiredImport}`)
    }
  }
  const report = { errors, hostDependencies, upstream: null }
  if (upstream) {
    const baseline = revision(root, manifest.upstreamBase)
    const candidate = revision(root, upstream)
    git(root, ['merge-base', '--is-ancestor', baseline, candidate])
    const names = (args) => git(root, args).split('\0').filter(Boolean)
    const upstreamFiles = names([
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      baseline,
      candidate,
      '--'
    ])
    const forkFiles = new Set([
      ...names(['diff', '--name-only', '--no-renames', '-z', baseline, '--']),
      ...names(['ls-files', '--others', '--exclude-standard', '-z'])
    ])
    const coreOverlaps = upstreamFiles.filter((file) => forkFiles.has(file))
    const hostChanges = upstreamFiles.filter((file) => hostDependencies.includes(file))
    const packageCollisions = upstreamFiles.filter(
      (file) => file.startsWith(`${PACKAGE_ROOT}/`) || file.startsWith('extensions/engineering/')
    )
    report.upstream = { baseline, candidate, coreOverlaps, hostChanges, packageCollisions }
  }
  return report
}

export function reportExitCode(report) {
  if (report.errors.length) {
    return 1
  }
  const impact = report.upstream
  return impact &&
    (impact.coreOverlaps.length || impact.hostChanges.length || impact.packageCollisions.length)
    ? 2
    : 0
}

function main(args) {
  const options = {}
  let json = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--json') {
      json = true
    } else if (args[index] === '--upstream' && args[index + 1]) {
      options.upstream = args[++index]
    } else {
      throw new Error('Usage: check-swarm-integration.mjs [--upstream <revision>] [--json]')
    }
  }
  const root = path.resolve(import.meta.dirname, '../..')
  const report = inspectSwarmIntegration(root, options)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `Swarm integration: ${report.hostDependencies.length} host dependencies; ${report.errors.length} error(s).`
    )
    for (const error of report.errors) {
      console.error(error)
    }
    if (report.upstream) {
      for (const [label, files] of [
        ['Fork changes also touched upstream', report.upstream.coreOverlaps],
        ['Host dependencies changed upstream', report.upstream.hostChanges],
        ['Extension path collisions', report.upstream.packageCollisions]
      ]) {
        console.log(`${label}: ${files.length}`)
        for (const file of files) {
          console.log(`  ${file}`)
        }
      }
      console.log(
        'This is an overlap report. Typechecks, feature tests and migration checks are still required before updating.'
      )
    }
  }
  return reportExitCode(report)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
