#!/usr/bin/env node
/**
 * Pre-publish gate. Runs on `npm publish` (prepublishOnly) and can be run by
 * hand:
 *
 *   node scripts/check-publish-ready.mjs
 *   node scripts/check-publish-ready.mjs --strict   # fail on placeholder repo URLs
 *
 * It verifies the bundle shape DSH needs, the files npm must ship, the icon
 * limits, the test suite, and that market/index.json matches this version.
 */
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')
const problems = []
const warnings = []

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

required(packageJson.name === 'dsh-isolated-monitor' || packageJson.name.endsWith('/dsh-isolated-monitor'), 'package name must end with dsh-isolated-monitor')
required(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version), 'version must be exact SemVer')
required(typeof packageJson.engines?.dsh === 'string', 'engines.dsh is required')
required(packageJson.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at ./cordis.patch.yml')
required(Array.isArray(packageJson.files) && packageJson.files.includes('src'), 'files must include src')
required(packageJson.license === 'MIT', 'license must be MIT')
required(packageJson.type === 'module', 'package type must be module')

for (const file of [
  'src/index.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'assets/icon.svg',
  'locale/en.json',
  'locale/zh.json',
]) {
  required(await exists(join(root, file)), `missing ${file}`)
}

const iconPath = join(root, packageJson.icon ?? '')
if (packageJson.icon === undefined) {
  problems.push('package.json icon is missing')
} else if (!/\.(?:svg|png|jpe?g|webp)$/iu.test(packageJson.icon)) {
  problems.push('icon must be SVG, PNG, JPEG, or WebP')
} else {
  const info = await stat(iconPath).catch(() => undefined)
  if (info === undefined || !info.isFile()) problems.push('icon must be a regular file inside the package')
  else if (info.size > 256 * 1024) problems.push('icon exceeds DSH\'s 256 KiB limit')
}

for (const [key, value] of Object.entries(packageJson.repository ?? {})) {
  if (typeof value === 'string' && value.includes('your-org')) {
    const message = `package.json repository.${key} still uses the your-org placeholder`
    if (strict) problems.push(message)
    else warnings.push(message)
  }
}
if (packageJson.homepage?.includes('your-org')) {
  const message = 'package.json homepage still uses the your-org placeholder'
  if (strict) problems.push(message)
  else warnings.push(message)
}
for (const peer of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session']) {
  if (packageJson.peerDependencies?.[peer] === undefined) problems.push(`peerDependencies must declare ${peer}`)
}

const tests = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: root, stdio: 'inherit' })
if (tests.status !== 0) problems.push('the test suite failed')

const marketCheck = spawnSync(process.execPath, ['scripts/make-market-index.mjs', '--check'], {
  cwd: root,
  stdio: 'inherit',
})
if (marketCheck.status !== 0) {
  warnings.push('market/index.json is missing or stale; run `npm run market:build` before publishing an index')
}

if (warnings.length > 0) {
  console.warn('\nWarnings:')
  for (const warning of warnings) console.warn(`  - ${warning}`)
}
if (problems.length > 0) {
  console.error('\nNot publishable:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\nPublish-ready: ${packageJson.name}@${packageJson.version}`)

function required(condition, message) {
  if (!condition) problems.push(message)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
