import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import process from 'node:process'

const COM_BASE = 'https://transcriptapi.com/api/v2'
const IO_BASE = 'https://api.transcriptapi.io'
const NO_CAPTION_ERRORS = new Set(['TranscriptsDisabled', 'NoTranscriptFound'])
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization'])

function requiredEnv(name, fallback) {
  const value = process.env[name] || fallback
  if (!value) throw new Error('Missing required environment variable: ' + name)
  return value
}

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(name + ' must be between ' + min + ' and ' + max)
  }
  return value
}

function boolEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function round(value, places = 2) {
  const n = 10 ** places
  return Math.round(value * n) / n
}

function average(values) {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return round(sorted[index])
}

function normalizeText(value) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tokenSet(value) {
  return new Set(value.split(/\s+/u).filter(Boolean))
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  const union = a.size + b.size - intersection
  return union ? intersection / union : 1
}

function safeRatio(a, b) {
  if (a === 0 && b === 0) return 1
  if (a === 0 || b === 0) return 0
  return Math.min(a, b) / Math.max(a, b)
}

function headersObject(headers) {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [
    name,
    SENSITIVE_HEADERS.has(name.toLowerCase()) ? '<redacted>' : value,
  ]))
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function httpGetJson({ provider, operation, url, apiKey, videoId = null }) {
  const startedAt = new Date().toISOString()
  const started = performance.now()

  try {
    const response = await fetch(url, {
      headers: {
        authorization: 'Bearer ' + apiKey,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })

    const bodyText = await response.text()
    return {
      provider,
      operation,
      videoId,
      request: {
        method: 'GET',
        url: url.toString(),
        headers: { accept: 'application/json', authorization: 'Bearer <redacted>' },
        startedAt,
        timeoutMs: 30_000,
      },
      response: {
        receivedAt: new Date().toISOString(),
        latencyMs: round(performance.now() - started),
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: headersObject(response.headers),
        bodyText,
        bodyJson: parseJson(bodyText),
      },
      networkError: null,
    }
  } catch (error) {
    return {
      provider,
      operation,
      videoId,
      request: {
        method: 'GET',
        url: url.toString(),
        headers: { accept: 'application/json', authorization: 'Bearer <redacted>' },
        startedAt,
        timeoutMs: 30_000,
      },
      response: null,
      networkError: {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        latencyMs: round(performance.now() - started),
        occurredAt: new Date().toISOString(),
      },
    }
  }
}

function comTranscriptUrl(videoId, language) {
  const url = new URL(COM_BASE + '/youtube/transcript')
  url.searchParams.set('video_url', videoId)
  url.searchParams.set('format', 'json')
  url.searchParams.set('include_timestamp', 'true')
  url.searchParams.set('send_metadata', 'true')
  if (language) url.searchParams.set('language', language)
  return url
}

function comInfoUrl(videoId) {
  const url = new URL(COM_BASE + '/youtube/info')
  url.searchParams.set('video_url', videoId)
  return url
}

function ioTranscriptUrl(videoId, language) {
  const url = new URL(IO_BASE + '/transcript')
  url.searchParams.set('video_id', videoId)
  if (language) url.searchParams.set('language', language)
  return url
}

function ioChannelVideosUrl(channel, limit) {
  const url = new URL(IO_BASE + '/channel/videos')
  url.searchParams.set('channel_id', channel)
  url.searchParams.set('limit', String(limit))
  return url
}

function transcriptStats(call) {
  const payload = call.response?.bodyJson
  if (!call.response?.ok || !payload || !Array.isArray(payload.transcript)) return null

  const segments = payload.transcript.flatMap((segment) => {
    if (typeof segment?.text !== 'string' || typeof segment?.start !== 'number' || typeof segment?.duration !== 'number') {
      return []
    }
    return [{
      text: segment.text,
      start: Math.max(0, segment.start),
      duration: Math.max(0, segment.duration),
    }]
  })

  if (!segments.length) return null

  const joined = segments.map((segment) => segment.text).join(' ')
  const normalized = normalizeText(joined)
  const last = segments[segments.length - 1]

  return {
    segmentCount: segments.length,
    rawCharCount: joined.length,
    normalizedCharCount: normalized.length,
    tokenCount: normalized ? normalized.split(/\s+/u).length : 0,
    normalizedSha256: sha256(normalized),
    firstStartSec: round(segments[0].start),
    lastEndSec: round(last.start + last.duration),
    summedSegmentDurationSec: round(segments.reduce((sum, segment) => sum + segment.duration, 0)),
    declaredVideoLengthSec: typeof payload.length_seconds === 'number' ? payload.length_seconds : null,
    language: typeof payload.language === 'string' ? payload.language : null,
    source: typeof payload.source === 'string' ? payload.source : null,
    translatedTo: typeof payload.translated_to === 'string' ? payload.translated_to : null,
    metadata: payload.metadata ?? null,
    preview: segments.slice(0, 5),
    _normalizedText: normalized,
    _tokens: tokenSet(normalized),
  }
}

function publicStats(stats) {
  if (!stats) return null
  const { _normalizedText, _tokens, ...safe } = stats
  return safe
}

function errorText(call) {
  const json = call.response?.bodyJson
  return [
    typeof json?.detail === 'string' ? json.detail : '',
    typeof json?.message === 'string' ? json.message : '',
    typeof json?.error === 'string' ? json.error : '',
    typeof json?.code === 'string' ? json.code : '',
    call.response?.bodyText ?? '',
  ].join(' ').toLowerCase()
}

function captionAssessment(comInfo, comTranscript, ioTranscript, ioStats) {
  const signals = []
  const languages = comInfo.response?.bodyJson?.available_languages

  if (comInfo.response?.ok && Array.isArray(languages) && languages.length) {
    signals.push({
      source: 'transcriptapi.com/info',
      type: 'captions_available',
      detail: languages,
    })
  }

  if (comInfo.response?.status === 404) {
    signals.push({
      source: 'transcriptapi.com/info',
      type: 'no_captions_candidate',
      detail: comInfo.response.bodyJson ?? comInfo.response.bodyText,
    })
  }

  if (comTranscript.response?.status === 404 && /(no transcript|caption)/i.test(errorText(comTranscript))) {
    signals.push({
      source: 'transcriptapi.com/transcript',
      type: 'no_captions_candidate',
      detail: comTranscript.response.bodyJson ?? comTranscript.response.bodyText,
    })
  }

  const ioError = ioTranscript.response?.bodyJson?.error
  if (typeof ioError === 'string' && NO_CAPTION_ERRORS.has(ioError)) {
    signals.push({
      source: 'transcriptapi.io/transcript',
      type: 'no_captions_candidate',
      detail: ioTranscript.response.bodyJson,
    })
  } else if (!ioTranscript.response?.ok && /(no transcript|caption)/i.test(errorText(ioTranscript))) {
    signals.push({
      source: 'transcriptapi.io/transcript',
      type: 'no_captions_candidate',
      detail: ioTranscript.response?.bodyJson ?? ioTranscript.response?.bodyText,
    })
  }

  const noCaptions = signals.some((signal) => signal.type === 'no_captions_candidate')
  const captionsAvailable = signals.some((signal) => signal.type === 'captions_available')
  const ioRecovered = noCaptions && Boolean(ioStats)
  const ioSource = ioStats?.source ?? null

  let classification = 'unknown'
  if (noCaptions && ioRecovered && ioSource === 'asr') classification = 'no_captions_recovered_by_io_asr'
  else if (noCaptions && ioRecovered) classification = 'no_captions_but_io_succeeded'
  else if (noCaptions) classification = 'no_captions_not_recovered'
  else if (captionsAvailable) classification = 'captions_available'

  return { classification, noCaptions, captionsAvailable, ioRecovered, ioSource, signals }
}

function compareStats(comStats, ioStats) {
  if (!comStats || !ioStats) {
    return {
      bothSucceeded: false,
      comSucceeded: Boolean(comStats),
      ioSucceeded: Boolean(ioStats),
    }
  }

  return {
    bothSucceeded: true,
    exactNormalizedText: comStats.normalizedSha256 === ioStats.normalizedSha256,
    tokenJaccard: round(jaccard(comStats._tokens, ioStats._tokens), 4),
    normalizedCharCountRatio: round(safeRatio(comStats.normalizedCharCount, ioStats.normalizedCharCount), 4),
    segmentCountRatio: round(safeRatio(comStats.segmentCount, ioStats.segmentCount), 4),
    lastEndDeltaSec: round(Math.abs(comStats.lastEndSec - ioStats.lastEndSec)),
  }
}

function providerSummary(entries, key) {
  const rows = entries.map((entry) => entry[key])
  const successful = rows.filter((row) => row.stats)
  const latencies = rows
    .map((row) => row.call.response?.latencyMs ?? row.call.networkError?.latencyMs)
    .filter((value) => typeof value === 'number')
  const failures = {}

  for (const row of rows.filter((item) => !item.stats)) {
    const status = row.call.response?.status
    const code = row.call.response?.bodyJson?.error
      ?? row.call.response?.bodyJson?.code
      ?? row.call.networkError?.name
      ?? 'unknown'
    const failureKey = status ? String(status) + ':' + String(code) : String(code)
    failures[failureKey] = (failures[failureKey] ?? 0) + 1
  }

  return {
    attempted: rows.length,
    succeeded: successful.length,
    failed: rows.length - successful.length,
    successRatePct: round((successful.length / Math.max(rows.length, 1)) * 100),
    latencyMsAllCalls: {
      average: average(latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    successfulTranscriptAverage: {
      segments: average(successful.map((row) => row.stats.segmentCount)),
      normalizedChars: average(successful.map((row) => row.stats.normalizedCharCount)),
      tokens: average(successful.map((row) => row.stats.tokenCount)),
      finalTimestampSec: average(successful.map((row) => row.stats.lastEndSec)),
    },
    failures,
  }
}

function parseIds(value) {
  if (!value) return []
  return [...new Set(value.split(',').map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item)))]
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let next = 0

  async function worker() {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\\n', 'utf8')
}

function isNoCaptionPreflight(call) {
  return call.response?.status === 404
}

async function selectDataset({ comKey, ioKey, channel, videoCount, discoveryPool, noCaptionsTarget, concurrency, explicitIds, outputDir }) {
  if (explicitIds.length) {
    if (explicitIds.length !== videoCount) {
      throw new Error('BENCHMARK_VIDEO_IDS must contain exactly ' + videoCount + ' unique valid IDs')
    }
    const preflights = await mapWithConcurrency(explicitIds, concurrency, (videoId) =>
      httpGetJson({
        provider: 'transcriptapi.com',
        operation: 'youtube/info',
        url: comInfoUrl(videoId),
        apiKey: comKey,
        videoId,
      }),
    )
    return {
      videoIds: explicitIds,
      preflightById: new Map(explicitIds.map((id, index) => [id, preflights[index]])),
      mode: 'explicit_ids',
      discoveredNoCaptionsCandidates: preflights.filter(isNoCaptionPreflight).length,
    }
  }

  const listing = await httpGetJson({
    provider: 'transcriptapi.io',
    operation: 'channel/videos',
    url: ioChannelVideosUrl(channel, discoveryPool),
    apiKey: ioKey,
  })
  await writeJson(outputDir + '/discovery/io-channel-videos.json', listing)

  if (!listing.response?.ok) {
    throw new Error('Could not discover channel videos: HTTP ' + (listing.response?.status ?? 'network error'))
  }

  const candidates = (listing.response.bodyJson?.videos ?? [])
    .filter((video) => typeof video?.id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(video.id))
    .slice(0, discoveryPool)

  if (candidates.length < videoCount) {
    throw new Error('Channel returned only ' + candidates.length + ' usable videos; need ' + videoCount)
  }

  const preflightRows = await mapWithConcurrency(candidates, concurrency, async (video, index) => {
    const info = await httpGetJson({
      provider: 'transcriptapi.com',
      operation: 'youtube/info',
      url: comInfoUrl(video.id),
      apiKey: comKey,
      videoId: video.id,
    })
    await writeJson(
      outputDir + '/discovery/preflight-' + String(index + 1).padStart(3, '0') + '-' + video.id + '.json',
      { channelVideo: video, comInfo: info },
    )
    return { video, info, noCaptionsCandidate: isNoCaptionPreflight(info) }
  })

  const noCaptionRows = preflightRows.filter((row) => row.noCaptionsCandidate).slice(0, noCaptionsTarget)
  const selected = [...noCaptionRows]
  const selectedIds = new Set(selected.map((row) => row.video.id))

  for (const row of preflightRows) {
    if (selected.length >= videoCount) break
    if (selectedIds.has(row.video.id)) continue
    selected.push(row)
    selectedIds.add(row.video.id)
  }

  return {
    videoIds: selected.map((row) => row.video.id),
    preflightById: new Map(selected.map((row) => [row.video.id, row.info])),
    mode: 'channel_scan',
    discoveredNoCaptionsCandidates: noCaptionRows.length,
  }
}

function previewLines(stats) {
  if (!stats?.preview?.length) return ['_No transcript preview._']
  return stats.preview.map((segment) =>
    '- ' + segment.start.toFixed(2) + 's (+' + segment.duration.toFixed(2) + 's): ' + segment.text.replace(/\\n/g, ' '),
  )
}

function summaryMarkdown(report) {
  const com = report.providers.com
  const io = report.providers.io
  return [
    '# Transcript provider benchmark',
    '',
    'Generated: ' + report.generatedAt,
    'Main dataset: ' + report.dataset.videoCount + ' identical YouTube video IDs',
    'Selection: ' + report.dataset.mode,
    'Channel: ' + report.dataset.channel,
    'No-captions cases detected: ' + report.noCaptionsCaseCount,
    '',
    '| Provider | Success | Success rate | p50 ms | p95 ms | avg ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    '| transcriptapi.com | ' + com.succeeded + '/' + com.attempted + ' | ' + com.successRatePct + '% | ' + (com.latencyMsAllCalls.p50 ?? '—') + ' | ' + (com.latencyMsAllCalls.p95 ?? '—') + ' | ' + (com.latencyMsAllCalls.average ?? '—') + ' |',
    '| transcriptapi.io | ' + io.succeeded + '/' + io.attempted + ' | ' + io.successRatePct + '% | ' + (io.latencyMsAllCalls.p50 ?? '—') + ' | ' + (io.latencyMsAllCalls.p95 ?? '—') + ' | ' + (io.latencyMsAllCalls.average ?? '—') + ' |',
    '',
    '## Cross-provider comparison',
    '',
    '- Both succeeded: ' + report.comparison.bothSucceeded,
    '- Exact normalized-text matches: ' + report.comparison.exactTextMatches,
    '- Average token Jaccard: ' + (report.comparison.averageTokenJaccard ?? '—'),
    '- Average character-count ratio: ' + (report.comparison.averageNormalizedCharCountRatio ?? '—'),
    '- Average segment-count ratio: ' + (report.comparison.averageSegmentCountRatio ?? '—'),
    '- Average final timestamp delta: ' + (report.comparison.averageLastEndDeltaSec ?? '—') + ' sec',
    '',
    'Raw HTTP bodies and full transcript arrays are saved under videos/<video-id>/ when BENCHMARK_CAPTURE_RAW=true.',
    'Those files are diagnostic-only and must not be committed.',
    '',
  ].join('\\n')
}

function detailsMarkdown(entries, generatedAt) {
  const lines = ['# Detailed per-video benchmark', '', 'Generated: ' + generatedAt, '']

  for (const entry of entries) {
    lines.push(
      '## ' + entry.videoId,
      '',
      'Caption classification: **' + entry.captionAssessment.classification + '**',
      'Signals: ' + (entry.captionAssessment.signals.map((signal) => signal.source + ':' + signal.type).join('; ') || 'none'),
      '',
      '### transcriptapi.com',
      '',
      'HTTP: ' + (entry.com.call.response?.status ?? 'network error') + '; latency: ' + (entry.com.call.response?.latencyMs ?? entry.com.call.networkError?.latencyMs ?? '—') + ' ms',
      'Language: ' + (entry.com.stats?.language ?? '—') + '; source: ' + (entry.com.stats?.source ?? '—') + '; segments: ' + (entry.com.stats?.segmentCount ?? '—'),
      ...previewLines(entry.com.stats),
      '',
      '### transcriptapi.io',
      '',
      'HTTP: ' + (entry.io.call.response?.status ?? 'network error') + '; latency: ' + (entry.io.call.response?.latencyMs ?? entry.io.call.networkError?.latencyMs ?? '—') + ' ms',
      'Language: ' + (entry.io.stats?.language ?? '—') + '; source: ' + (entry.io.stats?.source ?? '—') + '; segments: ' + (entry.io.stats?.segmentCount ?? '—'),
      ...previewLines(entry.io.stats),
      '',
      'Comparison: ' + JSON.stringify(entry.comparison),
      'Raw directory: videos/' + entry.videoId + '/',
      '',
    )
  }

  return lines.join('\\n')
}

function noCaptionsMarkdown(cases) {
  const lines = [
    '# No-captions benchmark',
    '',
    'Cases detected: ' + cases.length,
    '',
    '| Video | Classification | .com status | .io status | .io source | .io recovered |',
    '| --- | --- | ---: | ---: | --- | --- |',
  ]

  if (!cases.length) {
    lines.push('| — | no cases in dataset | — | — | — | — |')
  } else {
    for (const item of cases) {
      lines.push(
        '| ' + item.videoId + ' | ' + item.classification + ' | ' + (item.comStatus ?? '—') + ' | ' + (item.ioStatus ?? '—') + ' | ' + (item.ioSource ?? '—') + ' | ' + (item.ioRecovered ? 'yes' : 'no') + ' |',
      )
    }
  }

  lines.push(
    '',
    'Exact provider error bodies and full successful responses are preserved in each videos/<video-id>/ directory.',
    'If .io succeeds with source="asr" for a case where caption preflight failed, that directly confirms ASR fallback for that tested case.',
    '',
  )

  return lines.join('\\n')
}

async function main() {
  const comKey = requiredEnv('BENCHMARK_TRANSCRIPT_COM_KEY', process.env.NUXT_TRANSCRIPT_API_KEY)
  const ioKey = requiredEnv('BENCHMARK_TRANSCRIPT_IO_KEY')
  const channel = process.env.BENCHMARK_CHANNEL || '@TED'
  const language = process.env.BENCHMARK_LANGUAGE?.trim() || ''
  const videoCount = Math.floor(numberEnv('BENCHMARK_VIDEO_COUNT', 50, 1, 200))
  const discoveryPool = Math.floor(numberEnv('BENCHMARK_DISCOVERY_POOL', 100, videoCount, 200))
  const noCaptionsTarget = Math.floor(numberEnv('BENCHMARK_NO_CAPTIONS_TARGET', 10, 0, videoCount))
  const concurrency = Math.floor(numberEnv('BENCHMARK_CONCURRENCY', 2, 1, 5))
  const captureRaw = boolEnv('BENCHMARK_CAPTURE_RAW', true)
  const outputDir = process.env.BENCHMARK_OUTPUT_DIR || './benchmark-results'
  const explicitIds = parseIds(process.env.BENCHMARK_VIDEO_IDS)
  const extraNoCaptionIds = parseIds(process.env.BENCHMARK_NO_CAPTIONS_VIDEO_IDS)

  await mkdir(outputDir + '/videos', { recursive: true })
  await mkdir(outputDir + '/discovery', { recursive: true })

  const selected = await selectDataset({
    comKey,
    ioKey,
    channel,
    videoCount,
    discoveryPool,
    noCaptionsTarget,
    concurrency,
    explicitIds,
    outputDir,
  })

  const allIds = [...selected.videoIds]
  for (const id of extraNoCaptionIds) if (!allIds.includes(id)) allIds.push(id)

  const entries = await mapWithConcurrency(allIds, concurrency, async (videoId, index) => {
    const dir = outputDir + '/videos/' + videoId
    await mkdir(dir, { recursive: true })

    const comInfo = selected.preflightById.get(videoId) ?? await httpGetJson({
      provider: 'transcriptapi.com',
      operation: 'youtube/info',
      url: comInfoUrl(videoId),
      apiKey: comKey,
      videoId,
    })

    const [comCall, ioCall] = await Promise.all([
      httpGetJson({
        provider: 'transcriptapi.com',
        operation: 'youtube/transcript',
        url: comTranscriptUrl(videoId, language),
        apiKey: comKey,
        videoId,
      }),
      httpGetJson({
        provider: 'transcriptapi.io',
        operation: 'transcript',
        url: ioTranscriptUrl(videoId, language),
        apiKey: ioKey,
        videoId,
      }),
    ])

    const comStats = transcriptStats(comCall)
    const ioStats = transcriptStats(ioCall)
    const assessment = captionAssessment(comInfo, comCall, ioCall, ioStats)
    const comparison = compareStats(comStats, ioStats)

    if (captureRaw) {
      await Promise.all([
        writeJson(dir + '/com-info.json', comInfo),
        writeJson(dir + '/com-transcript.json', comCall),
        writeJson(dir + '/io-transcript.json', ioCall),
      ])
    }

    await writeJson(dir + '/analysis.json', {
      videoId,
      includedInMainDataset: selected.videoIds.includes(videoId),
      explicitNoCaptionsCase: extraNoCaptionIds.includes(videoId),
      com: { stats: publicStats(comStats) },
      io: { stats: publicStats(ioStats) },
      captionAssessment: assessment,
      comparison,
    })

    console.log(
      '[' + String(index + 1).padStart(2, '0') + '/' + allIds.length + '] '
      + videoId + ' .com=' + (comCall.response?.status ?? 'ERR')
      + ' .io=' + (ioCall.response?.status ?? 'ERR')
      + ' ' + assessment.classification,
    )

    return {
      videoId,
      includedInMainDataset: selected.videoIds.includes(videoId),
      explicitNoCaptionsCase: extraNoCaptionIds.includes(videoId),
      comInfo,
      com: { call: comCall, stats: comStats },
      io: { call: ioCall, stats: ioStats },
      captionAssessment: assessment,
      comparison,
    }
  })

  const mainEntries = entries.filter((entry) => entry.includedInMainDataset)
  const comparable = mainEntries.filter((entry) => entry.comparison.bothSucceeded)
  const noCaptionEntries = entries.filter((entry) => entry.captionAssessment.noCaptions)

  const report = {
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    dataset: {
      videoCount: mainEntries.length,
      totalExecutedVideoCount: entries.length,
      videoIds: selected.videoIds,
      explicitNoCaptionsVideoIds: extraNoCaptionIds,
      channel: explicitIds.length ? 'explicit BENCHMARK_VIDEO_IDS' : channel,
      mode: selected.mode,
      discoveryPool,
      noCaptionsTarget,
      discoveredNoCaptionsCandidates: selected.discoveredNoCaptionsCandidates,
      language,
      concurrency,
      captureRaw,
    },
    providers: {
      com: providerSummary(mainEntries, 'com'),
      io: providerSummary(mainEntries, 'io'),
    },
    comparison: {
      bothSucceeded: comparable.length,
      exactTextMatches: comparable.filter((entry) => entry.comparison.exactNormalizedText).length,
      averageTokenJaccard: average(comparable.map((entry) => entry.comparison.tokenJaccard)),
      averageNormalizedCharCountRatio: average(comparable.map((entry) => entry.comparison.normalizedCharCountRatio)),
      averageSegmentCountRatio: average(comparable.map((entry) => entry.comparison.segmentCountRatio)),
      averageLastEndDeltaSec: average(comparable.map((entry) => entry.comparison.lastEndDeltaSec)),
    },
    noCaptionsCaseCount: noCaptionEntries.length,
    videos: mainEntries.map((entry) => ({
      videoId: entry.videoId,
      com: {
        status: entry.com.call.response?.status ?? null,
        headers: entry.com.call.response?.headers ?? null,
        stats: publicStats(entry.com.stats),
      },
      io: {
        status: entry.io.call.response?.status ?? null,
        headers: entry.io.call.response?.headers ?? null,
        stats: publicStats(entry.io.stats),
      },
      captionAssessment: entry.captionAssessment,
      comparison: entry.comparison,
    })),
  }

  const noCaptions = {
    generatedAt: report.generatedAt,
    cases: noCaptionEntries.map((entry) => ({
      videoId: entry.videoId,
      includedInMainDataset: entry.includedInMainDataset,
      explicitNoCaptionsCase: entry.explicitNoCaptionsCase,
      classification: entry.captionAssessment.classification,
      signals: entry.captionAssessment.signals,
      comStatus: entry.com.call.response?.status ?? null,
      comError: entry.com.call.response?.ok ? null : (entry.com.call.response?.bodyJson ?? entry.com.call.response?.bodyText ?? entry.com.call.networkError),
      ioStatus: entry.io.call.response?.status ?? null,
      ioError: entry.io.call.response?.ok ? null : (entry.io.call.response?.bodyJson ?? entry.io.call.response?.bodyText ?? entry.io.call.networkError),
      ioRecovered: entry.captionAssessment.ioRecovered,
      ioSource: entry.captionAssessment.ioSource,
      comStats: publicStats(entry.com.stats),
      ioStats: publicStats(entry.io.stats),
      rawDirectory: 'videos/' + entry.videoId,
    })),
  }

  await Promise.all([
    writeJson(outputDir + '/dataset.json', { ...report.dataset, allExecutedVideoIds: allIds }),
    writeJson(outputDir + '/summary.json', report),
    writeFile(outputDir + '/summary.md', summaryMarkdown(report), 'utf8'),
    writeFile(outputDir + '/details.md', detailsMarkdown(mainEntries, report.generatedAt), 'utf8'),
    writeJson(outputDir + '/no-captions.json', noCaptions),
    writeFile(outputDir + '/no-captions.md', noCaptionsMarkdown(noCaptions.cases), 'utf8'),
  ])

  console.log('\\n' + summaryMarkdown(report))
  console.log('Detailed artifacts: ' + outputDir)
  if (captureRaw) console.log('Raw provider bodies captured locally; do not commit benchmark-results/')
}

main().catch((error) => {
  console.error('Benchmark failed: ' + (error instanceof Error ? error.message : 'unknown error'))
  process.exitCode = 1
})
