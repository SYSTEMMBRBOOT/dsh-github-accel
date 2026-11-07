import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MIRRORS,
  accelerateUrl,
  fileNameFor,
  mirrorUrlsFor,
  normalizeConfig,
  normalizeRepo,
  orderMirrors,
  parseGitHubUrl,
  rankProbes,
  rawUrlFor,
} from '../lib/core.js'

test('parseGitHubUrl: repository forms', () => {
  const repo = parseGitHubUrl('https://github.com/octocat/Hello-World')
  assert.equal(repo.ok, true)
  assert.equal(repo.kind, 'repo')
  assert.equal(repo.owner, 'octocat')
  assert.equal(repo.repo, 'Hello-World')

  const short = parseGitHubUrl('octocat/Hello-World')
  assert.equal(short.ok, true)
  assert.equal(short.url, 'https://github.com/octocat/Hello-World')

  const clone = parseGitHubUrl('https://github.com/octocat/Hello-World.git')
  assert.equal(clone.repo, 'Hello-World')
})

test('parseGitHubUrl: file and asset forms', () => {
  const blob = parseGitHubUrl('https://github.com/o/r/blob/main/src/a.ts')
  assert.equal(blob.kind, 'blob')
  assert.equal(blob.ref, 'main')
  assert.equal(blob.file, 'src/a.ts')

  const raw = parseGitHubUrl('https://raw.githubusercontent.com/o/r/v1/README.md')
  assert.equal(raw.kind, 'raw')
  assert.equal(raw.ref, 'v1')
  assert.equal(raw.file, 'README.md')

  const release = parseGitHubUrl('https://github.com/o/r/releases/download/v1.2.3/app.zip')
  assert.equal(release.kind, 'release')
  assert.equal(release.ref, 'v1.2.3')
  assert.equal(release.file, 'app.zip')

  const archive = parseGitHubUrl('https://github.com/o/r/archive/refs/tags/v1.0.0.zip')
  assert.equal(archive.kind, 'archive')
  assert.equal(archive.ref, 'refs/tags/v1.0.0.zip')
})

test('parseGitHubUrl: api, gist and rejects', () => {
  const api = parseGitHubUrl('https://api.github.com/repos/o/r')
  assert.equal(api.kind, 'api')
  assert.equal(api.owner, 'o')
  assert.equal(api.repo, 'r')

  const gist = parseGitHubUrl('https://gist.github.com/user/abc123')
  assert.equal(gist.kind, 'gist')

  assert.equal(parseGitHubUrl('https://example.com/o/r').ok, false)
  assert.equal(parseGitHubUrl('ftp://github.com/o/r').ok, false)
  assert.equal(parseGitHubUrl('').ok, false)
})

test('rawUrlFor: blob becomes a raw URL, raw passes through', () => {
  const blob = parseGitHubUrl('https://github.com/o/r/blob/main/docs/readme.md')
  assert.equal(rawUrlFor(blob), 'https://raw.githubusercontent.com/o/r/main/docs/readme.md')
  const raw = parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/a.txt')
  assert.equal(rawUrlFor(raw), raw.url)
  const release = parseGitHubUrl('https://github.com/o/r/releases/download/v1/a.zip')
  assert.equal(rawUrlFor(release), null)
})

test('accelerateUrl: prefix, host and jsdelivr modes', () => {
  const repo = parseGitHubUrl('https://github.com/o/r')
  const raw = parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/f.md')
  const blob = parseGitHubUrl('https://github.com/o/r/blob/main/f.md')
  const release = parseGitHubUrl('https://github.com/o/r/releases/download/v1/a.zip')

  const ghproxy = DEFAULT_MIRRORS.find((m) => m.id === 'ghproxy')
  const kkgithub = DEFAULT_MIRRORS.find((m) => m.id === 'kkgithub')
  const jsdelivr = DEFAULT_MIRRORS.find((m) => m.id === 'jsdelivr')

  assert.equal(accelerateUrl(repo, ghproxy), 'https://ghproxy.net/https://github.com/o/r')
  assert.equal(accelerateUrl(raw, kkgithub), null, 'kkgithub only replaces github.com')
  assert.equal(accelerateUrl(blob, jsdelivr), 'https://cdn.jsdelivr.net/gh/o/r@main/f.md')
  assert.equal(accelerateUrl(release, jsdelivr), null, 'jsDelivr serves raw content only')

  const cloneUrl = parseGitHubUrl('https://github.com/o/r.git')
  assert.equal(accelerateUrl(cloneUrl, kkgithub, 'clone'), 'https://kkgithub.com/o/r.git')
})

test('accelerateUrl: custom host mirror', () => {
  const mirror = {
    id: 'raw-mirror',
    label: 'raw.example',
    mode: 'host',
    base: 'https://raw.example',
    hosts: ['raw.githubusercontent.com'],
    caps: ['raw'],
  }
  const raw = parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/f.md')
  assert.equal(accelerateUrl(raw, mirror), 'https://raw.example/o/r/main/f.md')
})

test('mirrorUrlsFor: filters by capability', () => {
  const repo = parseGitHubUrl('https://github.com/o/r')
  const web = mirrorUrlsFor(repo, DEFAULT_MIRRORS, 'web').map((c) => c.mirror)
  assert.ok(web.includes('ghproxy'))
  assert.ok(!web.includes('jsdelivr'))

  const clone = mirrorUrlsFor(repo, DEFAULT_MIRRORS, 'clone').map((c) => c.mirror)
  assert.deepEqual(clone.sort(), ['gh-proxy', 'ghfast', 'ghproxy', 'ghproxy-cc', 'kkgithub'])
})

test('normalizeConfig: defaults, overrides and clamping', () => {
  const defaults = normalizeConfig()
  assert.equal(defaults.defaultMirror, 'auto')
  assert.equal(defaults.mirrors.length, DEFAULT_MIRRORS.length)
  assert.equal(defaults.directFallback, true)
  assert.equal(defaults.cloneDepth, 1)

  const custom = normalizeConfig({
    mirrors: [
      'https://ghproxy.net/',
      { id: 'kkgithub', label: 'kkgithub', mode: 'host', base: 'https://kkgithub.com' },
      { id: 'bad', base: 'not-a-url' },
      { id: 'off', base: 'https://off.example/', enabled: false },
    ],
    timeoutMs: 999999,
    cloneDepth: 0,
    probeTtlSeconds: -5,
  })
  assert.equal(custom.mirrors.length, 2)
  assert.equal(custom.mirrors[0].id, 'mirror-1')
  assert.equal(custom.mirrors[1].mode, 'host')
  assert.equal(custom.timeoutMs, 120000)
  assert.equal(custom.cloneDepth, 1)
  assert.equal(custom.probeTtlSeconds, 0)
})

test('normalizeRepo: short form, URL and clone URL', () => {
  assert.deepEqual(normalizeRepo('o/r'), {
    ok: true,
    owner: 'o',
    repo: 'r',
    webUrl: 'https://github.com/o/r',
    cloneUrl: 'https://github.com/o/r.git',
  })
  assert.equal(normalizeRepo('https://github.com/o/r.git').repo, 'r')
  assert.equal(normalizeRepo('https://github.com/o/r/tree/main').ok, true)
  assert.equal(normalizeRepo('https://example.com/o/r').ok, false)
  assert.equal(normalizeRepo('nope').ok, false)
})

test('rankProbes and orderMirrors', () => {
  const results = [
    { mirror: 'a', ok: true, bytes: 10, bytesPerSecond: 100, latencyMs: 10 },
    { mirror: 'b', ok: true, bytes: 10, bytesPerSecond: 300, latencyMs: 40 },
    { mirror: 'c', ok: false, bytes: 0, bytesPerSecond: 0, latencyMs: 0 },
  ]
  assert.deepEqual(rankProbes(results).map((r) => r.mirror), ['b', 'a'])

  const mirrors = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(orderMirrors(mirrors, { rankedIds: ['c', 'b'] }).map((m) => m.id), ['c', 'b', 'a'])
  assert.deepEqual(orderMirrors(mirrors, { preferred: 'b', rankedIds: ['c'] }).map((m) => m.id), ['b', 'c', 'a'])
})

test('fileNameFor: safe asset names', () => {
  assert.equal(fileNameFor('https://github.com/o/r/releases/download/v1/app.zip'), 'app.zip')
  assert.equal(fileNameFor('https://example.com/a%20b.txt'), 'a b.txt')
  assert.equal(fileNameFor('https://example.com/'), 'download.bin')
})
