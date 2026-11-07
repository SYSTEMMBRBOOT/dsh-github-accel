/**
 * dsh-github-accel 鈥?GitHub acceleration for DeepSeek Harness.
 *
 * Registers five model-facing tools (resolve / probe / download / clone / read)
 * that route GitHub traffic through a configurable list of mirrors. The mirror
 * list is healthy-first: `github_accel_probe` measures real throughput and the
 * other tools prefer the fastest mirror, falling back to the next one when a
 * download fails.
 *
 * The module keeps no state beyond a probe cache. All network and filesystem
 * work happens inside a tool call, so the plugin has no background traffic.
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tls from 'node:tls'

import {
  accelerateUrl,
  fileNameFor,
  mirrorUrlsFor,
  normalizeConfig,
  normalizeRepo,
  orderMirrors,
  parseGitHubUrl,
  rankProbes,
  rawUrlFor,
} from './lib/core.js'

const NAME = 'dsh-github-accel'
const VERSION = '1.0.0'
const USER_AGENT = `${NAME}/${VERSION} (+https://github.com/SYSTEMMBRBOOT/dsh-github-accel)`
const DEFAULT_MIRROR = 'auto'

/**
 * Tool definitions are plain objects: the registry consumes the same shape the
 * `defineTool` helper from `@deepseek-ai/dsh-tools` produces, and building it
 * inline keeps this bundle free of a peer dependency on a Harness-internal
 * package that the plugin loader does not resolve for profile bundles.
 */
const defineTool = (definition) => definition

export const inject = ['tools']

/* -------------------------------------------------------------------------- */
/* small helpers                                                               */
/* -------------------------------------------------------------------------- */

function loggerFor(ctx) {
  try {
    return typeof ctx.logger === 'function' ? ctx.logger(NAME) : ctx.logger
  } catch {
    return undefined
  }
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error && typeof error === 'object' ? error.cause : undefined
  const code = cause && typeof cause === 'object' ? cause.code : undefined
  return code ? `${message} (${code})` : message
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '-'
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Merge the platform trust store into Node's built-in roots. Corporate TLS
 * inspection proxies (the usual reason `fetch` fails while `curl` works) are
 * trusted by the OS but not by Node's bundled root list.
 */
function trustSystemCertificates(logger) {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
      return false
    }
    const system = tls.getCACertificates('system') || []
    if (system.length === 0) return false
    tls.setDefaultCACertificates([...new Set([...tls.rootCertificates, ...system])])
    return true
  } catch (error) {
    logger?.warn?.(`could not merge the system certificate store: ${errorText(error)}`)
    return false
  }
}

/**
 * Run `fn(res)` with a response whose body remains covered by the timeout and
 * the caller's abort signal. `fetch` resolves on headers, so a plain
 * `AbortSignal.timeout` would stop applying before the body is consumed.
 */
async function withFetch(url, { timeoutMs, signal, headers = {}, method = 'GET' }, fn) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, ...headers },
      signal: controller.signal,
    })
    return await fn(response, controller)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

async function pathExists(target) {
  try {
    return await stat(target)
  } catch {
    return null
  }
}

/** Resolve a user-supplied destination into a concrete file path. */
async function resolveFileDest(dest, url) {
  const fallback = resolvePath(process.cwd(), fileNameFor(url))
  if (!dest || !String(dest).trim()) return fallback
  const wanted = resolvePath(String(dest).trim())
  if (/[\\/]$/.test(String(dest))) return join(wanted, fileNameFor(url))
  const info = await pathExists(wanted)
  if (info?.isDirectory()) return join(wanted, fileNameFor(url))
  return wanted
}

/* -------------------------------------------------------------------------- */
/* probe                                                                       */
/* -------------------------------------------------------------------------- */

function probeTargets(settings) {
  const parsed = parseGitHubUrl(settings.probeUrl)
  if (!parsed.ok) {
    throw new Error(`probeUrl is not a GitHub URL: ${settings.probeUrl}`)
  }
  const targets = []
  if (settings.directFallback) {
    targets.push({ mirror: 'direct', label: 'direct', url: parsed.url })
  }
  for (const mirror of settings.mirrors) {
    const url = accelerateUrl(parsed, mirror, 'raw')
    if (url) targets.push({ mirror: mirror.id, label: mirror.label, url })
  }
  return { parsed, targets }
}

async function measureTarget(settings, target) {
  const started = performance.now()
  let status = 0
  let bytes = 0
  let firstByteAt = 0
  try {
    return await withFetch(
      target.url,
      {
        timeoutMs: settings.probeTimeoutMs,
        headers: { range: `bytes=0-${Math.max(0, settings.probeBytes - 1)}` },
      },
      async (response) => {
        status = response.status
        if (!response.ok) throw new Error(`HTTP ${status}`)
        if (!response.body) throw new Error('Empty response body')
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!firstByteAt) firstByteAt = performance.now()
          bytes += value.byteLength
          if (bytes >= settings.probeBytes) break
        }
        try {
          await reader.cancel()
        } catch {
          /* the body is already complete or aborted */
        }
        const totalMs = Math.max(1, performance.now() - started)
        return {
          mirror: target.mirror,
          label: target.label,
          url: target.url,
          ok: true,
          status,
          bytes,
          latencyMs: Math.max(1, Math.round((firstByteAt || performance.now()) - started)),
          totalMs: Math.round(totalMs),
          bytesPerSecond: Math.round(bytes / (totalMs / 1000)),
        }
      },
    )
  } catch (error) {
    return {
      mirror: target.mirror,
      label: target.label,
      url: target.url,
      ok: false,
      status,
      bytes,
      latencyMs: 0,
      totalMs: Math.round(performance.now() - started),
      bytesPerSecond: 0,
      error: errorText(error),
    }
  }
}

function probeCacheKey(settings) {
  return JSON.stringify({
    mirrors: settings.mirrors.map((m) => [m.id, m.mode, m.base, m.caps]),
    url: settings.probeUrl,
    bytes: settings.probeBytes,
  })
}

/* -------------------------------------------------------------------------- */
/* transfer helpers                                                            */
/* -------------------------------------------------------------------------- */

async function downloadToFile(settings, url, dest, signal) {
  return withFetch(url, { timeoutMs: settings.timeoutMs, signal }, async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('Empty response body')
    await mkdir(dirname(dest), { recursive: true })
    const temp = `${dest}.${process.pid}.part`
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
      await rename(temp, dest)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    const info = await stat(dest)
    return {
      bytes: info.size,
      contentType: response.headers.get('content-type') || '',
    }
  })
}

async function readText(settings, url, maxBytes, signal) {
  return withFetch(url, { timeoutMs: settings.timeoutMs, signal }, async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('Empty response body')
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (total <= maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value.byteLength
    }
    try {
      await reader.cancel()
    } catch {
      /* body already finished */
    }
    const buffer = Buffer.concat(chunks)
    const truncated = buffer.length > maxBytes
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer
    return {
      content: slice.toString('utf8'),
      bytes: slice.byteLength,
      truncated,
      contentType: response.headers.get('content-type') || '',
    }
  })
}

function runGit(args, { timeoutMs, signal, cwd }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch (error) {
      reject(error)
      return
    }
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(reject, new Error('Clone aborted by the caller.'))
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(reject, new Error(`git clone timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000)
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, { stderr })
        return
      }
      const tail = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2)
        .join(' ')
      finish(reject, new Error(`git exited with code ${code}${tail ? `: ${tail}` : ''}`))
    })
  })
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                      */
/* -------------------------------------------------------------------------- */

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
  const log = loggerFor(ctx)

  if (!settings.enabled) {
    log?.info?.('disabled by configuration; no tools registered')
    return
  }
  if (settings.trustSystemCa) trustSystemCertificates(log)
  if (settings.mirrors.length === 0) {
    log?.warn?.('no usable mirrors configured; only direct GitHub URLs will be served')
  }

  const state = {
    probe: { key: '', at: 0, results: [] },
    probing: null,
  }

  function cachedProbe() {
    const key = probeCacheKey(settings)
    const fresh = Date.now() - state.probe.at < settings.probeTtlSeconds * 1000
    return key === state.probe.key && fresh && state.probe.results.length > 0
      ? state.probe
      : null
  }

  async function probe({ force = false } = {}) {
    const cached = force ? null : cachedProbe()
    if (cached) {
      return { checkedAt: cached.at, cached: true, results: cached.results }
    }
    if (state.probing) {
      const shared = await state.probing
      return { ...shared, cached: true }
    }
    const { targets } = probeTargets(settings)
    if (targets.length === 0) throw new Error('No probe targets: mirrors are empty and directFallback is off.')
    const run = (async () => {
      const results = await Promise.all(targets.map((target) => measureTarget(settings, target)))
      const checkedAt = Date.now()
      state.probe = { key: probeCacheKey(settings), at: checkedAt, results }
      return { checkedAt, cached: false, results }
    })()
    state.probing = run
    try {
      return await run
    } finally {
      state.probing = null
    }
  }

  /** Mirror list ordered by fresh probe results, then by config order. */
  async function orderedMirrors(preferred) {
    if (preferred && preferred !== DEFAULT_MIRROR) {
      const chosen = settings.mirrors.filter((m) => m.id === preferred || m.label === preferred)
      const rest = settings.mirrors.filter((m) => !chosen.includes(m))
      return [...chosen, ...rest]
    }
    let ranked = []
    if (settings.mirrors.length > 1) {
      try {
        const { results } = await probe()
        ranked = rankProbes(results)
          .filter((r) => r.mirror !== 'direct')
          .map((r) => r.mirror)
      } catch (error) {
        log?.warn?.(`probe failed, using configured order: ${errorText(error)}`)
      }
    }
    return orderMirrors(settings.mirrors, { rankedIds: ranked, preferred: 'auto' })
  }

  /**
   * Mirror URLs plus direct GitHub, ordered by the probe: direct is inserted at
   * its measured position instead of always being last, so a fast direct route
   * is not slowed down by a throttled mirror.
   */
  async function candidatesFor(parsed, preferred, purpose = undefined) {
    const mirrors = await orderedMirrors(preferred)
    const list = mirrorUrlsFor(parsed, mirrors, purpose)
    if (!settings.directFallback) return list
    const direct = { mirror: 'direct', label: 'direct', url: parsed.url }
    if (preferred === 'direct') return [direct, ...list]
    const cached = cachedProbe()
    if (!cached || (preferred && preferred !== DEFAULT_MIRROR)) return [...list, direct]
    const ranked = rankProbes(cached.results).map((r) => r.mirror)
    const position = ranked.indexOf('direct')
    if (position < 0) return [...list, direct]
    const before = ranked.slice(0, position).filter((id) => list.some((c) => c.mirror === id)).length
    list.splice(before, 0, direct)
    return list
  }

  function register(tool) {
    const dispose = ctx.tools.register(tool)
    ctx.effect?.(() => dispose)
  }

  /* ------------------------------ resolve ------------------------------ */

  register(defineTool({
    name: 'github_accel_resolve',
    description:
      'Rewrite a GitHub URL into mirrored download URLs and report its kind (repo, raw, blob, release, archive, api) plus owner/repo/ref. Use it to pick a mirror before fetching or cloning when direct GitHub is slow or unreachable. It makes no network request; mirror order comes from the last probe.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'GitHub URL, or owner/repo. Accepts github.com, raw.githubusercontent.com, codeload.github.com, api.github.com and gist.github.com.',
        },
        purpose: {
          type: 'string',
          enum: ['raw', 'release', 'archive', 'web', 'clone', 'auto'],
          description: 'Routing class. clone adds clone-capable mirrors for a repository URL; auto (default) derives it from the URL.',
        },
        mirror: {
          type: 'string',
          description: `Preferred mirror id or label from the configuration. Default: ${DEFAULT_MIRROR} (probe-ranked).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          kind: { type: 'string' },
          owner: { type: 'string' },
          repo: { type: 'string' },
          ref: { type: 'string' },
          file: { type: 'string' },
          original: { type: 'string' },
          canonicalRaw: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mirror: { type: 'string' },
                label: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
          recommended: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      const parsed = parseGitHubUrl(args.url)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const purpose = ['raw', 'release', 'archive', 'web', 'clone'].includes(args.purpose)
        ? args.purpose
        : parsed.kind === 'repo'
          ? 'web'
          : undefined
      try {
        const candidates = await candidatesFor(parsed, args.mirror, purpose)
        const canonicalRaw = rawUrlFor(parsed)
        return {
          ok: true,
          kind: parsed.kind,
          owner: parsed.owner,
          repo: parsed.repo,
          ref: parsed.ref || '',
          file: parsed.file || '',
          original: parsed.url,
          canonicalRaw: canonicalRaw || '',
          candidates,
          recommended: candidates[0]?.mirror || 'direct',
        }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }))

  /* ------------------------------- probe ------------------------------- */

  register(defineTool({
    name: 'github_accel_probe',
    description:
      'Measure every configured GitHub mirror (and direct GitHub) by downloading the first block of a fixed raw file, then rank them by throughput. Results are cached for the configured TTL. Use it when mirrors seem stale, before a large download or clone, or when a mirror just failed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        force: {
          type: 'boolean',
          description: 'Ignore the cached result and probe again. Default: false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          checkedAt: { type: 'string' },
          cached: { type: 'boolean' },
          probeUrl: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mirror: { type: 'string' },
                label: { type: 'string' },
                url: { type: 'string' },
                ok: { type: 'boolean' },
                status: { type: 'integer' },
                bytes: { type: 'integer' },
                latencyMs: { type: 'integer' },
                totalMs: { type: 'integer' },
                bytesPerSecond: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
          recommended: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `Probe failed: ${value.error}` }]
        const rows = value.results.map((r) =>
          r.ok
            ? `${r.mirror.padEnd(12)} ${String(r.status).padEnd(4)} ${`${r.latencyMs} ms`.padEnd(8)} ${formatSpeed(r.bytesPerSecond).padEnd(12)} ${formatBytes(r.bytes)}`
            : `${r.mirror.padEnd(12)} FAIL ${r.error || ''}`,
        )
        return [{
          type: 'text',
          text: [
            `GitHub mirror probe at ${value.checkedAt}${value.cached ? ' (cached)' : ''}`,
            `source: ${value.probeUrl}`,
            ...rows,
            `recommended: ${value.recommended}`,
          ].join('\n'),
        }]
      },
    },
    timeoutMs: 120000,
    execute: async (args) => {
      try {
        const { checkedAt, cached, results } = await probe({ force: args.force === true })
        const ranked = rankProbes(results)
        const ok = ranked.length > 0
        const payload = {
          ok,
          checkedAt: new Date(checkedAt).toISOString(),
          cached,
          probeUrl: settings.probeUrl,
          results,
          recommended: ranked[0]?.mirror || '',
        }
        if (!ok) payload.error = 'All probe targets failed.'
        return payload
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }))

  /* ------------------------------ download ------------------------------ */

  register(defineTool({
    name: 'github_accel_download',
    description:
      'Download a GitHub file, release asset, or source archive through the fastest mirror, trying the next mirror when one fails. Creates parent directories and writes atomically (no partial file is left behind). Returns the saved path, size, mirror and measured speed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'GitHub URL of the file, release asset, or archive to download.',
        },
        dest: {
          type: 'string',
          description: 'Destination file path or existing directory. Default: the asset name in the current working directory.',
        },
        mirror: {
          type: 'string',
          description: `Preferred mirror id or label. Default: ${DEFAULT_MIRROR} (fastest from the last probe).`,
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing destination file. Default: false.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-mirror transfer timeout in milliseconds (2000-120000).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          bytes: { type: 'integer' },
          mirror: { type: 'string' },
          elapsedMs: { type: 'integer' },
          bytesPerSecond: { type: 'integer' },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mirror: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Downloaded ${formatBytes(value.bytes)} via ${value.mirror} in ${value.elapsedMs} ms (${formatSpeed(value.bytesPerSecond)})\n${value.path}`
          : `Download failed: ${value.error}`,
      }],
    },
    timeoutMs: 300000,
    execute: async (args, exec) => {
      const parsed = parseGitHubUrl(args.url)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const dest = await resolveFileDest(args.dest, parsed.url)
      const existing = await pathExists(dest)
      if (existing && !args.overwrite) {
        return { ok: false, error: `Destination already exists: ${dest}. Pass overwrite: true to replace it.` }
      }
      const timeoutMs = Number.isFinite(args.timeoutMs)
        ? Math.min(120000, Math.max(2000, Math.round(args.timeoutMs)))
        : settings.timeoutMs
      const runSettings = { ...settings, timeoutMs }
      const candidates = await candidatesFor(parsed, args.mirror)
      if (candidates.length === 0) return { ok: false, error: 'No mirror can serve this URL.' }

      const attempts = []
      const started = performance.now()
      for (const candidate of candidates) {
        try {
          const result = await downloadToFile(runSettings, candidate.url, dest, exec?.signal)
          const elapsedMs = Math.round(performance.now() - started)
          return {
            ok: true,
            path: dest,
            bytes: result.bytes,
            mirror: candidate.mirror,
            elapsedMs,
            bytesPerSecond: Math.round(result.bytes / Math.max(0.001, elapsedMs / 1000)),
            attempts,
          }
        } catch (error) {
          attempts.push({ mirror: candidate.mirror, error: errorText(error) })
        }
      }
      return { ok: false, attempts, error: `Every mirror failed (${attempts.length} attempts).` }
    },
  }))

  /* -------------------------------- clone -------------------------------- */

  register(defineTool({
    name: 'github_accel_clone',
    description:
      'Shallow-clone a GitHub repository through the fastest mirror, deleting the partial checkout and trying the next mirror when a clone fails. Requires git on PATH. The destination must be absent or empty.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['repo'],
      properties: {
        repo: {
          type: 'string',
          description: 'Repository as owner/name or a github.com URL.',
        },
        dest: {
          type: 'string',
          description: 'Destination directory. Default: the repository name in the current working directory.',
        },
        depth: {
          type: 'integer',
          description: 'Shallow history depth (1-100). Default: the configured cloneDepth (1).',
        },
        mirror: {
          type: 'string',
          description: `Preferred mirror id or label. Default: ${DEFAULT_MIRROR} (fastest clone-capable mirror).`,
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout for the whole clone in milliseconds (5000-1800000).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          mirror: { type: 'string' },
          elapsedMs: { type: 'integer' },
          depth: { type: 'integer' },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mirror: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Cloned via ${value.mirror} in ${value.elapsedMs} ms (depth ${value.depth})\n${value.path}`
          : `Clone failed: ${value.error}`,
      }],
    },
    timeoutMs: 900000,
    execute: async (args, exec) => {
      const repo = normalizeRepo(args.repo)
      if (!repo.ok) return { ok: false, error: repo.error }
      const dest = args.dest && String(args.dest).trim()
        ? resolvePath(String(args.dest).trim())
        : resolvePath(process.cwd(), repo.repo)
      const depth = Number.isFinite(args.depth)
        ? Math.min(100, Math.max(1, Math.round(args.depth)))
        : settings.cloneDepth
      const timeoutMs = Number.isFinite(args.timeoutMs)
        ? Math.min(1800000, Math.max(5000, Math.round(args.timeoutMs)))
        : settings.cloneTimeoutMs

      const existing = await pathExists(dest)
      if (existing) {
        const entries = existing.isDirectory() ? await readdir(dest).catch(() => []) : []
        if (!existing.isDirectory() || entries.length > 0) {
          return { ok: false, error: `Destination already exists and is not empty: ${dest}` }
        }
      }

      const parsed = parseGitHubUrl(repo.cloneUrl)
      const candidates = await candidatesFor(parsed, args.mirror, 'clone')
      if (candidates.length === 0) return { ok: false, error: 'No clone-capable mirror is configured.' }

      const attempts = []
      const started = performance.now()
      for (const candidate of candidates) {
        try {
          await runGit(
            ['clone', '--depth', String(depth), '--single-branch', '--no-tags', candidate.url, dest],
            { timeoutMs, signal: exec?.signal, cwd: process.cwd() },
          )
          return {
            ok: true,
            path: dest,
            mirror: candidate.mirror,
            elapsedMs: Math.round(performance.now() - started),
            depth,
            attempts,
          }
        } catch (error) {
          attempts.push({ mirror: candidate.mirror, error: errorText(error) })
          await rm(dest, { recursive: true, force: true }).catch(() => {})
        }
      }
      return { ok: false, attempts, error: `Every mirror failed (${attempts.length} attempts).` }
    },
  }))

  /* --------------------------------- read -------------------------------- */

  register(defineTool({
    name: 'github_accel_read',
    description:
      'Read a small text file from GitHub (raw or blob URL) through the fastest mirror and return its content. Content stops at maxBytes and reports truncated: true; use github_accel_download for larger files or binaries.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'Raw or blob URL of a text file on GitHub.',
        },
        mirror: {
          type: 'string',
          description: `Preferred mirror id or label. Default: ${DEFAULT_MIRROR} (fastest from the last probe).`,
        },
        maxBytes: {
          type: 'integer',
          description: 'Maximum bytes to return (1024-8388608). Default: the configured maxReadBytes (262144).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          content: { type: 'string' },
          bytes: { type: 'integer' },
          truncated: { type: 'boolean' },
          mirror: { type: 'string' },
          contentType: { type: 'string' },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mirror: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.path} via ${value.mirror} (${formatBytes(value.bytes)}${value.truncated ? ', truncated' : ''})\n\n${value.content}`
          : `Read failed: ${value.error}`,
      }],
    },
    timeoutMs: 120000,
    execute: async (args, exec) => {
      const parsed = parseGitHubUrl(args.url)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      const raw = rawUrlFor(parsed)
      if (!raw) return { ok: false, error: 'Not a readable file URL: pass a raw or blob URL.' }
      const rawParsed = parseGitHubUrl(raw)
      const maxBytes = Number.isFinite(args.maxBytes)
        ? Math.min(8388608, Math.max(1024, Math.round(args.maxBytes)))
        : settings.maxReadBytes
      const candidates = await candidatesFor(rawParsed, args.mirror, 'raw')
      if (candidates.length === 0) return { ok: false, error: 'No mirror can serve this URL.' }

      const attempts = []
      for (const candidate of candidates) {
        try {
          const result = await readText(settings, candidate.url, maxBytes, exec?.signal)
          return {
            ok: true,
            path: `${rawParsed.owner}/${rawParsed.repo}/${rawParsed.ref}/${rawParsed.file}`,
            content: result.content,
            bytes: result.bytes,
            truncated: result.truncated,
            mirror: candidate.mirror,
            contentType: result.contentType,
            attempts,
          }
        } catch (error) {
          attempts.push({ mirror: candidate.mirror, error: errorText(error) })
        }
      }
      return { ok: false, attempts, error: `Every mirror failed (${attempts.length} attempts).` }
    },
  }))

  log?.info?.(
    `mounted with ${settings.mirrors.length} mirror(s); probe source ${settings.probeUrl}`,
  )
}
