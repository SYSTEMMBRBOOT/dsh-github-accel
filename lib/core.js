/**
 * dsh-github-accel — pure logic: config normalization, GitHub URL parsing,
 * mirror rewriting, and result ranking. No I/O lives in this module so it can
 * be unit tested without a network or a Harness runtime.
 */

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const SHORT_REPO_RE = /^[\w.-]+\/[\w.-]+$/
const PROBE_CAPS = ['raw']

/** A small, public, rarely changing file used to compare mirror throughput. */
export const DEFAULT_PROBE_URL = 'https://raw.githubusercontent.com/nodejs/node/main/README.md'

/**
 * Built-in mirrors. `mode` decides how a GitHub URL is rewritten:
 *  - prefix   : `<base>/<original url>`        (ghproxy family)
 *  - host     : replace the GitHub host         (kkgithub)
 *  - jsdelivr : `cdn.jsdelivr.net/gh/o/r@ref/path` for raw content
 */
export const DEFAULT_MIRRORS = [
  {
    id: 'ghproxy',
    label: 'ghproxy.net',
    mode: 'prefix',
    base: 'https://ghproxy.net/',
    caps: ['raw', 'release', 'archive', 'web', 'clone'],
  },
  {
    id: 'ghfast',
    label: 'ghfast.top',
    mode: 'prefix',
    base: 'https://ghfast.top/',
    caps: ['raw', 'release', 'archive', 'web', 'clone'],
  },
  {
    id: 'gh-proxy',
    label: 'gh-proxy.com',
    mode: 'prefix',
    base: 'https://gh-proxy.com/',
    caps: ['raw', 'release', 'archive', 'web', 'clone'],
  },
  {
    id: 'ghproxy-cc',
    label: 'ghproxy.cc',
    mode: 'prefix',
    base: 'https://ghproxy.cc/',
    caps: ['raw', 'release', 'archive', 'web', 'clone'],
  },
  {
    id: 'moeyy',
    label: 'github.moeyy.xyz',
    mode: 'prefix',
    base: 'https://github.moeyy.xyz/',
    caps: ['raw', 'release', 'archive'],
  },
  {
    id: 'kkgithub',
    label: 'kkgithub.com',
    mode: 'host',
    base: 'https://kkgithub.com',
    hosts: ['github.com'],
    caps: ['web', 'clone'],
  },
  {
    id: 'jsdelivr',
    label: 'jsDelivr',
    mode: 'jsdelivr',
    base: 'https://cdn.jsdelivr.net/',
    caps: ['raw'],
  },
]

export const DEFAULT_CONFIG = {
  enabled: true,
  mirrors: DEFAULT_MIRRORS,
  /** 'auto' (probe-ranked) or a mirror id. */
  defaultMirror: 'auto',
  directFallback: true,
  timeoutMs: 20000,
  probeTimeoutMs: 15000,
  probeUrl: DEFAULT_PROBE_URL,
  probeBytes: 65536,
  probeTtlSeconds: 600,
  cloneDepth: 1,
  cloneTimeoutMs: 300000,
  maxReadBytes: 262144,
  trustSystemCa: true,
}

function clamp(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function trimBase(base) {
  return String(base || '').trim().replace(/\/+$/, '')
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function defaultCaps(mode) {
  if (mode === 'jsdelivr') return ['raw']
  if (mode === 'host') return ['web', 'raw', 'clone']
  return ['raw', 'release', 'archive', 'web', 'clone']
}

function normalizeMirror(entry, index) {
  const source = typeof entry === 'string' ? { base: entry } : entry
  if (!source || typeof source !== 'object') return null
  const base = trimBase(source.base)
  if (!/^https?:\/\//i.test(base)) return null
  const mode = source.mode || (base.includes('cdn.jsdelivr.net') ? 'jsdelivr' : 'prefix')
  if (!['prefix', 'host', 'jsdelivr'].includes(mode)) return null
  const id = String(source.id || `mirror-${index + 1}`).trim()
  if (!id) return null
  return {
    id,
    label: String(source.label || hostOf(base) || id).trim(),
    mode,
    base,
    hosts: Array.isArray(source.hosts) && source.hosts.length
      ? source.hosts.map((h) => String(h).toLowerCase())
      : mode === 'host'
        ? ['github.com']
        : [],
    caps: Array.isArray(source.caps) && source.caps.length
      ? source.caps.filter((c) => typeof c === 'string')
      : defaultCaps(mode),
    enabled: source.enabled !== false,
  }
}

/** Accepts partial config; every field falls back to `DEFAULT_CONFIG`. */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const provided = Array.isArray(input.mirrors) ? input.mirrors : DEFAULT_MIRRORS
  const mirrors = provided
    .map((m, i) => normalizeMirror(m, i))
    .filter((m) => m && m.enabled)

  return {
    enabled: input.enabled !== false,
    mirrors,
    defaultMirror: typeof input.defaultMirror === 'string' && input.defaultMirror.trim()
      ? input.defaultMirror.trim()
      : DEFAULT_CONFIG.defaultMirror,
    directFallback: input.directFallback !== false,
    timeoutMs: clamp(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 2000, 120000),
    probeTimeoutMs: clamp(input.probeTimeoutMs, DEFAULT_CONFIG.probeTimeoutMs, 1000, 60000),
    probeUrl: typeof input.probeUrl === 'string' && input.probeUrl.trim()
      ? input.probeUrl.trim()
      : DEFAULT_PROBE_URL,
    probeBytes: clamp(input.probeBytes, DEFAULT_CONFIG.probeBytes, 1024, 1048576),
    probeTtlSeconds: clamp(input.probeTtlSeconds, DEFAULT_CONFIG.probeTtlSeconds, 0, 86400),
    cloneDepth: clamp(input.cloneDepth, DEFAULT_CONFIG.cloneDepth, 1, 100),
    cloneTimeoutMs: clamp(input.cloneTimeoutMs, DEFAULT_CONFIG.cloneTimeoutMs, 5000, 1800000),
    maxReadBytes: clamp(input.maxReadBytes, DEFAULT_CONFIG.maxReadBytes, 1024, 8388608),
    trustSystemCa: input.trustSystemCa !== false,
  }
}

export function capabilityOf(parsed) {
  switch (parsed.kind) {
    case 'raw':
    case 'blob':
      return 'raw'
    case 'release':
      return 'release'
    case 'archive':
      return 'archive'
    case 'api':
      return 'api'
    case 'gist':
      return 'gist'
    default:
      return 'web'
  }
}

/**
 * Parse a GitHub URL (or a bare `owner/repo`) into its parts.
 * Returns `{ ok: false, error }` for anything that is not GitHub.
 */
export function parseGitHubUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'A GitHub URL is required.' }
  }
  let raw = input.trim()
  if (!SCHEME_RE.test(raw)) {
    if (SHORT_REPO_RE.test(raw)) raw = `https://github.com/${raw}`
    else raw = `https://${raw.replace(/^\/+/, '')}`
  }

  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: `Not a valid URL: ${input}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs are supported.' }
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const seg = url.pathname.split('/').filter(Boolean)
  const base = { ok: true, host, url: url.href, pathname: url.pathname }

  if (host === 'github.com') {
    const owner = seg[0] || ''
    const repo = (seg[1] || '').replace(/\.git$/i, '')
    if (!owner || !repo) {
      return { ok: false, error: `Not a repository URL: ${input}` }
    }
    const rest = seg.slice(2)
    let kind = 'web'
    let ref = ''
    let file = ''
    if (rest.length === 0) kind = 'repo'
    else if (rest[0] === 'releases' && rest[1] === 'download') {
      kind = 'release'
      ref = rest[2] || ''
      file = rest.slice(3).join('/')
    } else if (rest[0] === 'archive') {
      kind = 'archive'
      ref = rest.slice(1).join('/')
    } else if (rest[0] === 'raw' && rest.length >= 3) {
      kind = 'raw'
      ref = rest[1]
      file = rest.slice(2).join('/')
    } else if (rest[0] === 'blob' && rest.length >= 3) {
      kind = 'blob'
      ref = rest[1]
      file = rest.slice(2).join('/')
    } else if (rest[0] === 'tree' && rest.length >= 2) {
      kind = 'tree'
      ref = rest[1]
      file = rest.slice(2).join('/')
    }
    return { ...base, kind, owner, repo, ref, file }
  }

  if (host === 'raw.githubusercontent.com' && seg.length >= 3) {
    return {
      ...base,
      kind: 'raw',
      owner: seg[0],
      repo: seg[1],
      ref: seg[2],
      file: seg.slice(3).join('/'),
    }
  }

  if (host === 'codeload.github.com' && seg.length >= 3) {
    return {
      ...base,
      kind: 'archive',
      owner: seg[0],
      repo: seg[1],
      ref: seg.slice(3).join('/'),
      file: '',
    }
  }

  if (host === 'api.github.com') {
    const owner = seg[0] === 'repos' ? seg[1] || '' : ''
    const repo = seg[0] === 'repos' ? seg[2] || '' : ''
    return { ...base, kind: 'api', owner, repo, ref: '', file: '' }
  }

  if (host === 'gist.github.com') {
    return { ...base, kind: 'gist', owner: seg[0] || '', repo: seg[1] || '', ref: '', file: '' }
  }

  return { ok: false, error: `Not a GitHub URL: ${input}` }
}

/** Raw-content URL for blob/raw inputs; null when the URL is not a file. */
export function rawUrlFor(parsed) {
  if (parsed.kind === 'raw') return parsed.url
  if (parsed.kind !== 'blob' || !parsed.ref || !parsed.file) return null
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.file}`
}

/**
 * Rewrite `parsed.url` through one mirror.
 * `purpose` defaults to the URL's own capability; clone passes `'clone'`.
 */
export function accelerateUrl(parsed, mirror, purpose = capabilityOf(parsed)) {
  if (!parsed || !parsed.ok || !mirror) return null
  if (Array.isArray(mirror.caps) && mirror.caps.length && !mirror.caps.includes(purpose)) return null
  const base = trimBase(mirror.base)

  if (mirror.mode === 'prefix') {
    return `${base}/${parsed.url}`
  }

  if (mirror.mode === 'host') {
    const hosts = Array.isArray(mirror.hosts) ? mirror.hosts : []
    if (!hosts.includes(parsed.host)) return null
    let out
    try {
      out = new URL(parsed.url)
      const target = new URL(base)
      out.protocol = target.protocol
      out.host = target.host
    } catch {
      return null
    }
    return out.href
  }

  if (mirror.mode === 'jsdelivr') {
    if (parsed.kind !== 'raw' && parsed.kind !== 'blob') return null
    if (!parsed.ref || !parsed.file) return null
    return `https://cdn.jsdelivr.net/gh/${parsed.owner}/${parsed.repo}@${parsed.ref}/${parsed.file}`
  }

  return null
}

/** All mirror URLs for one parsed GitHub URL, in the given mirror order. */
export function mirrorUrlsFor(parsed, mirrors, purpose = capabilityOf(parsed)) {
  const out = []
  for (const mirror of mirrors || []) {
    const url = accelerateUrl(parsed, mirror, purpose)
    if (!url) continue
    out.push({ mirror: mirror.id, label: mirror.label, url })
  }
  return out
}

/** Stable ordering: preferred mirror first, then probe ranking, then config order. */
export function orderMirrors(mirrors, { preferred, rankedIds } = {}) {
  const list = Array.isArray(mirrors) ? [...mirrors] : []
  const rank = new Map((rankedIds || []).map((id, index) => [id, index]))
  const wanted = typeof preferred === 'string' && preferred !== 'auto' ? preferred : ''
  return list.sort((a, b) => {
    if (wanted) {
      if (a.id === wanted) return -1
      if (b.id === wanted) return 1
    }
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
    return ra - rb
  })
}

/** Successful probes, fastest throughput first, latency as the tie-break. */
export function rankProbes(results) {
  return [...(results || [])]
    .filter((r) => r && r.ok && r.bytes > 0)
    .sort((a, b) => (b.bytesPerSecond || 0) - (a.bytesPerSecond || 0) || (a.latencyMs || 0) - (b.latencyMs || 0))
}

/** Normalize `owner/repo`, a repo URL, or a clone URL into clone inputs. */
export function normalizeRepo(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'A repository (owner/name or URL) is required.' }
  }
  let raw = input.trim()
  if (SHORT_REPO_RE.test(raw)) raw = `https://github.com/${raw}`
  const parsed = parseGitHubUrl(raw)
  if (!parsed.ok) return parsed
  if (!parsed.owner || !parsed.repo || (parsed.kind !== 'repo' && parsed.kind !== 'web' && parsed.kind !== 'blob' && parsed.kind !== 'tree')) {
    return { ok: false, error: `Not a repository URL: ${input}` }
  }
  return {
    ok: true,
    owner: parsed.owner,
    repo: parsed.repo,
    webUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
    cloneUrl: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
  }
}

/** Best-effort file name for a download destination. */
export function fileNameFor(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
    const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
    return cleaned || 'download.bin'
  } catch {
    return 'download.bin'
  }
}
