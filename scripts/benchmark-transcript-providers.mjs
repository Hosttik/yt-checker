import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

const VIDEO_COUNT = 50
const COM_BASE = 'https://transcriptapi.com/api/v2'
const IO_BASE = 'https://api.transcriptapi.io'

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name] || fallback)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`)
  }
  return parsed
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  )
  return Math.round(sorted[index] * 100) / 100
}

function average(values) {
  if (values.length === 0) return null
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
}

function normalizeText(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(value) {
  return new Set(value.split(/\s+/u).filter(Boolean))
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 1 : intersection / union
}

function safeRatio(a, b) {
  if (a === 0 && b === 0) return 1
  if (a === 0 || b === 0) return 0
  return Math.min(a, b) / Math.max(a, b)
}

function transcriptStats(payload) {
  if (!payload || !Array.isArray(payload.transcript)) {
    throw new Error('Provider returned no timestamped transcript array.')
  }

  const segments = payload.transcript.flatMap((segment) => {
    if (
      typeof segment?.text !== 'string'
      || typeof segment?.start !== 'number'
      || typeof segment?.duration !== 'number'
    ) {
      return []
    }

    return [{
      text: segment.text,
      start: Math.max(0, segment.start),
      duration: Math.max(0, segment.duration),
    }]
  })

  if (segments.length === 0) {
    throw new Error('Provider returned an empty timestamped transcript.')
  }

  const normalized = normalizeText(segments.map((segment) => segment.text).join(' '))
  const tokens = tokenSet(normalized)
  const firstStart = segments[0].start
  const last = segments[segments.length - 1]
  const lastEnd = last.start + last.duration
  const summedDuration = segments.reduce((sum, segment) => sum + segment.duration, 0)

  return {
    privateText: normalized,
    privateTokens: tokens,
    metrics: {
      segmentCount: segments.length,
      charCount: normalized.length,
      tokenCount: normalized ? normalized.split(/\s+/u).length : 0,
      firstStartSec: Math.round(firstStart * 100) / 100,
      lastEndSec: Math.round(lastEnd * 100) / 100,
      summedDurationSec: Math.round(summedDuration * 100) / 100,
    },
  }
}

function sanitizedFailure(provider, videoId, status, latencyMs, kind) {
  return {
    provider,
    videoId,
    ok: false,
    status,
    latencyMs: Math.round(latencyMs * 100) / 100,
    errorKind: kind,
  }
}

async function callProvider({ provider, url, apiKey, videoId }) {
  const startedAt = performance.now()

  let response
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return sanitizedFailure(
      provider,
      videoId,
      null,
      performance.now() - startedAt,
      error?.name === 'TimeoutError' ? 'timeout' : 'network_error',
    )
  }

  const latencyMs = performance.now() - startedAt

  if (!response.ok) {
    // Deliberately do not read or persist provider error bodies.
    return sanitizedFailure(provider, videoId, response.status, latencyMs, 'http_error')
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    return sanitizedFailure(provider, videoId, response.status, latencyMs, 'invalid_json')
  }

  try {
    const stats = transcriptStats(payload)
    return {
      provider,
      videoId,
      ok: true,
      status: response.status,
      latencyMs: Math.round(latencyMs * 100) / 100,
      ...stats,
    }
  } catch {
    return sanitizedFailure(provider, videoId, response.status, latencyMs, 'invalid_transcript')
  }
}

function comUrl(videoId, language) {
  const url = new URL(`${COM_BASE}/youtube/transcript`)
  url.searchParams.set('video_url', videoId)
  url.searchParams.set('format', 'json')
  url.searchParams.set('include_timestamp', 'true')
  url.searchParams.set('send_metadata', 'false')
  if (language) url.searchParams.set('language', language)
  return url
}

function ioUrl(videoId, language) {
  const url = new URL(`${IO_BASE}/transcript`)
  url.searchParams.set('video_id', videoId)
  if (language) url.searchParams.set('language', language)
  return url
}

async function discoverVideoIds(ioKey, channel) {
  const url = new URL(`${IO_BASE}/channel/videos`)
  url.searchParams.set('channel_id', channel)
  url.searchParams.set('limit', String(VIDEO_COUNT))

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${ioKey}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`Could not discover benchmark videos: HTTP ${response.status}`)
  }

  const payload = await response.json()
  const ids = (payload?.videos ?? [])
    .map((video) => video?.id)
    .filter((id) => typeof id === 'string' && id.length === 11)
    .slice(0, VIDEO_COUNT)

  if (ids.length < VIDEO_COUNT) {
    throw new Error(`Channel returned only ${ids.length} usable videos; need ${VIDEO_COUNT}.`)
  }

  return ids
}

function parseVideoIds(value) {
  if (!value) return null

  const ids = [...new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item)),
  )]

  if (ids.length !== VIDEO_COUNT) {
    throw new Error(`BENCHMARK_VIDEO_IDS must contain exactly ${VIDEO_COUNT} unique valid video IDs.`)
  }

  return ids
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let next = 0

  async function worker() {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )

  return results
}

function providerSummary(results) {
  const successful = results.filter((item) => item.ok)
  const failed = results.filter((item) => !item.ok)
  const latencies = successful.map((item) => item.latencyMs)

  const failuresByStatus = {}
  for (const item of failed) {
    const key = item.status === null ? item.errorKind : String(item.status)
    failuresByStatus[key] = (failuresByStatus[key] ?? 0) + 1
  }

  return {
    attempted: results.length,
    succeeded: successful.length,
    failed: failed.length,
    successRatePct: Math.round((successful.length / results.length) * 10_000) / 100,
    latencyMs: {
      average: average(latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    transcript: {
      averageSegments: average(successful.map((item) => item.metrics.segmentCount)),
      averageChars: average(successful.map((item) => item.metrics.charCount)),
      averageLastEndSec: average(successful.map((item) => item.metrics.lastEndSec)),
    },
    failuresByStatus,
  }
}

function comparePair(com, io) {
  if (!com.ok || !io.ok) {
    return {
      videoId: com.videoId,
      bothSucceeded: false,
      comOk: com.ok,
      ioOk: io.ok,
    }
  }

  return {
    videoId: com.videoId,
    bothSucceeded: true,
    exactNormalizedText: com.privateText === io.privateText,
    tokenJaccard: Math.round(jaccard(com.privateTokens, io.privateTokens) * 10_000) / 10_000,
    charCountRatio: Math.round(safeRatio(com.metrics.charCount, io.metrics.charCount) * 10_000) / 10_000,
    segmentCountRatio: Math.round(safeRatio(com.metrics.segmentCount, io.metrics.segmentCount) * 10_000) / 10_000,
    lastEndDeltaSec: Math.round(Math.abs(com.metrics.lastEndSec - io.metrics.lastEndSec) * 100) / 100,
  }
}

function publicResult(result) {
  const { privateText: _text, privateTokens: _tokens, ...safe } = result
  return safe
}

function markdownReport(report) {
  const providerRows = [
    ['transcriptapi.com', report.providers.com],
    ['transcriptapi.io', report.providers.io],
  ]

  const rows = providerRows.map(([name, value]) =>
    `| ${name} | ${value.succeeded}/${value.attempted} | ${value.successRatePct}% | ${value.latencyMs.p50 ?? '—'} | ${value.latencyMs.p95 ?? '—'} | ${value.latencyMs.average ?? '—'} |`,
  ).join('\n')

  return `# Transcript provider benchmark

Dataset: ${report.dataset.videoCount} identical YouTube video IDs
Channel source: ${report.dataset.channel}
Language override: ${report.dataset.language || 'none'}
Concurrency: ${report.dataset.concurrency}

| Provider | Success | Success rate | p50 ms | p95 ms | avg ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

## Cross-provider output comparison

- Both succeeded: ${report.comparison.bothSucceeded}
- Exact normalized text matches: ${report.comparison.exactTextMatches}
- Average token Jaccard: ${report.comparison.averageTokenJaccard ?? '—'}
- Average character-count ratio: ${report.comparison.averageCharCountRatio ?? '—'}
- Average segment-count ratio: ${report.comparison.averageSegmentCountRatio ?? '—'}
- Average final timestamp delta: ${report.comparison.averageLastEndDeltaSec ?? '—'} sec

No transcript text is written to this report or JSON output.
`
}

async function main() {
  const comKey = requiredEnv('BENCHMARK_TRANSCRIPT_COM_KEY', process.env.NUXT_TRANSCRIPT_API_KEY)
  const ioKey = requiredEnv('BENCHMARK_TRANSCRIPT_IO_KEY')
  const channel = process.env.BENCHMARK_CHANNEL || '@TED'
  const language = process.env.BENCHMARK_LANGUAGE?.trim() || ''
  const concurrency = Math.min(5, Math.floor(numberEnv('BENCHMARK_CONCURRENCY', 2)))
  const outputDir = process.env.BENCHMARK_OUTPUT_DIR || './benchmark-results'

  const explicitIds = parseVideoIds(process.env.BENCHMARK_VIDEO_IDS)
  const videoIds = explicitIds ?? await discoverVideoIds(ioKey, channel)

  console.log(`Benchmarking ${videoIds.length} identical videos through both providers...`)
  console.log(`Channel: ${channel}; concurrency: ${concurrency}; language: ${language || 'provider default'}`)

  const pairs = await mapWithConcurrency(videoIds, concurrency, async (videoId, index) => {
    const [com, io] = await Promise.all([
      callProvider({
        provider: 'transcriptapi.com',
        url: comUrl(videoId, language),
        apiKey: comKey,
        videoId,
      }),
      callProvider({
        provider: 'transcriptapi.io',
        url: ioUrl(videoId, language),
        apiKey: ioKey,
        videoId,
      }),
    ])

    console.log(
      `[${String(index + 1).padStart(2, '0')}/${videoIds.length}] ${videoId}  .com=${com.ok ? Math.round(com.latencyMs) + 'ms' : 'FAIL'}  .io=${io.ok ? Math.round(io.latencyMs) + 'ms' : 'FAIL'}`,
    )

    return { com, io }
  })

  const comResults = pairs.map((pair) => pair.com)
  const ioResults = pairs.map((pair) => pair.io)
  const comparisons = pairs.map((pair) => comparePair(pair.com, pair.io))
  const comparable = comparisons.filter((item) => item.bothSucceeded)

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: {
      videoCount: videoIds.length,
      channel: explicitIds ? 'explicit BENCHMARK_VIDEO_IDS' : channel,
      language,
      concurrency,
    },
    providers: {
      com: providerSummary(comResults),
      io: providerSummary(ioResults),
    },
    comparison: {
      bothSucceeded: comparable.length,
      exactTextMatches: comparable.filter((item) => item.exactNormalizedText).length,
      averageTokenJaccard: average(comparable.map((item) => item.tokenJaccard)),
      averageCharCountRatio: average(comparable.map((item) => item.charCountRatio)),
      averageSegmentCountRatio: average(comparable.map((item) => item.segmentCountRatio)),
      averageLastEndDeltaSec: average(comparable.map((item) => item.lastEndDeltaSec)),
    },
    videos: pairs.map((pair, index) => ({
      videoId: videoIds[index],
      com: publicResult(pair.com),
      io: publicResult(pair.io),
      comparison: comparisons[index],
    })),
    privacy: {
      rawTranscriptPersisted: false,
      rawTranscriptPrinted: false,
      note: 'Raw transcript text is used only in memory to calculate comparison metrics.',
    },
  }

  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeFile(`${outputDir}/latest.json`, JSON.stringify(report, null, 2) + '\n', 'utf8'),
    writeFile(`${outputDir}/latest.md`, markdownReport(report), 'utf8'),
  ])

  console.log('\n' + markdownReport(report))
  console.log(`Detailed derived-only results: ${outputDir}/latest.json`)
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
})
