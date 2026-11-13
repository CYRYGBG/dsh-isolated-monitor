#!/usr/bin/env node
/**
 * Generate the DSH plugin-market index (format 1) for this bundle.
 *
 *   node scripts/make-market-index.mjs                 # npm source, current version
 *   node scripts/make-market-index.mjs --check         # fail if the committed index is stale
 *   node scripts/make-market-index.mjs --source git \
 *        --git-url https://github.com/you/dsh-isolated-monitor \
 *        --commit <40-hex-sha>
 *   node scripts/make-market-index.mjs --registry https://registry.npmmirror.com
 *   node scripts/make-market-index.mjs --index-url https://example.com/market/index.json
 *
 * The output lives in market/index.json and can be served from any HTTPS host
 * (GitHub raw, GitHub Pages, object storage). Users add that URL under
 * Plugins → Discover → Index sources.
 *
 * Set DSH_PLUGIN_MARKET_INDEX to the absolute path of
 * `@deepseek-ai/dsh-plugin-market-index/lib/index.js` to additionally validate
 * the document with DSH's own validator.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const args = parseArgs(process.argv.slice(2))

const outPath = resolve(root, args.out ?? 'market/index.json')
const iconSource = join(root, packageJson.icon ?? 'assets/icon.svg')
const iconTarget = join(dirname(outPath), 'icon.svg')

const localized = await readLocales()
const repositoryUrl = normalizeRepository(packageJson.repository?.url)
const homepage = packageJson.homepage?.replace(/#readme$/u, '')
if (repositoryUrl?.includes('your-org') || homepage?.includes('your-org')) {
  console.warn('warning: package.json still uses the your-org placeholder; set the real repository/homepage before publishing')
}
const indexUrl = args['index-url'] ?? defaultIndexUrl(repositoryUrl)
const dshRange = packageJson.engines?.dsh
if (dshRange === undefined) fail('package.json engines.dsh is required for the index')

const version = args.version ?? packageJson.version
const publishTimestamp = Number(
  args.timestamp ?? process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.now() / 1000),
)
if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0) fail('--timestamp must be Unix seconds')

const source = buildSource()
const index = {
  format: 1,
  title: { en: 'dsh-isolated-monitor', zh: '独立会话监控' },
  description: {
    en: 'Scheduled monitors that run in a fresh isolated Session: archive when normal, alert the creator conversation only on anomalies.',
    zh: '每次巡检新建独立会话：正常自动归档，只有异常才回传原始主对话。',
  },
  metadata: {
    categories: {
      automation: { title: { en: 'Automation', zh: '自动化' } },
      monitoring: { title: { en: 'Monitoring', zh: '监控' } },
    },
    labels: {
      host: { title: { en: 'Host plugin', zh: '宿主插件' } },
      'read-only': { title: { en: 'Read-only by default', zh: '默认只读' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: packageJson.name,
      title: localized.title,
      description: localized.description,
      ...(packageJson.author === undefined ? {} : { author: String(packageJson.author) }),
      ...(homepage === undefined ? {} : { homepage }),
      ...(repositoryUrl === undefined ? {} : { repository: { url: repositoryUrl } }),
      icon: './icon.svg',
      metadata: {
        category: 'monitoring',
        keywords: [
          'dsh-plugin',
          'monitor',
          'cron',
          'schedule',
          'isolated-session',
          'alert',
          '监控',
          '定时任务',
        ],
        labels: ['host', 'read-only'],
        sortKeys: {},
      },
      versions: [
        {
          version,
          publishTimestamp,
          source,
          engines: { dsh: dshRange },
        },
      ],
    },
  ],
}

if (args.check) {
  const current = await readIndex(outPath)
  if (current === undefined) fail(`${outPath} does not exist; run without --check`)
  const expected = index.plugins[0].versions[0]
  const actual = current.plugins?.[0]?.versions?.[0]
  if (actual === undefined) fail('index has no plugin version')
  if (actual.version !== expected.version) fail(`index version ${actual.version} != package ${expected.version}`)
  if (JSON.stringify(actual.engines) !== JSON.stringify(expected.engines)) fail('index engines.dsh is stale')
  if (JSON.stringify(actual.source) !== JSON.stringify(expected.source)) fail('index source is stale')
  await validate(current, indexUrl)
  console.log(`market index is current: ${packageJson.name}@${expected.version}`)
  process.exit(0)
}

await mkdir(dirname(outPath), { recursive: true })
await copyFile(iconSource, iconTarget)
await writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`)
await validate(index, indexUrl)
console.log(`wrote ${outPath}`)
console.log(`index URL for Discover: ${indexUrl}`)

function buildSource() {
  if (args.source === 'git' || args['git-url'] !== undefined) {
    const url = args['git-url'] ?? repositoryUrl
    const commit = args.commit
    if (url === undefined) fail('--git-url (or package.json repository) is required for a git source')
    if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+$/u.test(url)) fail('--git-url must be an https repository URL')
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) fail('--commit must be a 40-hex commit SHA')
    return {
      type: 'git',
      url,
      commit,
      ...(args.path === undefined ? {} : { path: args.path }),
    }
  }
  return {
    type: 'npm',
    ...(args.registry === undefined ? {} : { registry: args.registry }),
  }
}

async function readLocales() {
  const read = async (language, fallback) => {
    try {
      const value = JSON.parse(await readFile(join(root, 'locale', `${language}.json`), 'utf8'))
      return value.meta ?? {}
    } catch {
      return fallback
    }
  }
  const en = await read('en', {})
  const zh = await read('zh', {})
  return {
    title: {
      en: en.title ?? packageJson.name,
      ...(zh.title === undefined ? {} : { zh: zh.title }),
    },
    description: {
      en: en.description ?? packageJson.description,
      ...(zh.description === undefined ? {} : { zh: zh.description }),
    },
  }
}

function defaultIndexUrl(repository) {
  if (repository === undefined) return 'https://example.com/market/index.json'
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/u.exec(repository)
  if (match === null) return 'https://example.com/market/index.json'
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/main/market/index.json`
}

function normalizeRepository(value) {
  if (typeof value !== 'string') return undefined
  return value.replace(/^git\+/u, '').replace(/\.git$/u, '').replace(/#.*$/u, '')
}

async function readIndex(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function validate(document, at) {
  // Local invariants first: they catch the mistakes this generator can make.
  if (document.format !== 1) fail('index.format must be 1')
  if (document.title?.en === undefined) fail('index.title.en is required')
  if (!Array.isArray(document.plugins) || document.plugins.length === 0) fail('index.plugins must be non-empty')
  for (const plugin of document.plugins) {
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(plugin.name)) fail(`invalid package name ${plugin.name}`)
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) fail(`${plugin.name} has no versions`)
    for (const version of plugin.versions) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version.version)) {
        fail(`${plugin.name}@${version.version} is not an exact SemVer version`)
      }
      if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp <= 0) {
        fail(`${plugin.name}@${version.version} publishTimestamp must be Unix seconds`)
      }
      if (version.source?.type === 'npm') {
        if (version.source.registry !== undefined && !/^https?:\/\//u.test(version.source.registry)) {
          fail(`${plugin.name}@${version.version} registry must be an http(s) URL`)
        }
      } else if (version.source?.type === 'git') {
        if (!/^https:\/\/[^/]+\/[^/]+\/[^/]+$/u.test(version.source.url ?? '')) fail('git source url is invalid')
        if (!/^[0-9a-f]{40}$/u.test(version.source.commit ?? '')) fail('git source commit is invalid')
      } else {
        fail(`${plugin.name}@${version.version} source.type must be npm or git`)
      }
      if (typeof version.engines?.dsh !== 'string') fail(`${plugin.name}@${version.version} engines.dsh is required`)
    }
  }
  if (!/^https:\/\//u.test(at)) fail('index URL must be https for Discover')
  // Optional: DSH's own validator, when its path is provided.
  const validatorPath = process.env.DSH_PLUGIN_MARKET_INDEX
  if (validatorPath !== undefined) {
    const module = await import(pathToFileURL(resolve(validatorPath)).href)
    module.parseMarketIndex(document, at)
    console.log(`official validator accepted ${at}`)
  }
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      result[key] = true
    } else {
      result[key] = next
      index += 1
    }
  }
  return result
}

function fail(message) {
  console.error(`make-market-index: ${message}`)
  process.exit(1)
}
