import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  CandidateResolution,
  ChannelCheckResponse,
  RuleId,
  ScanStorageMode,
} from '../../shared/types/check'
import type { TranscriptApiExchange } from './transcript-api'
import type { JevExchange } from './jev-context-filter'

export interface AnalysisTraceEntry {
  timestamp: string
  event: string
  videoId?: string
  candidateId?: string
  ruleId?: RuleId
  ruleLabel?: string
  hitCount?: number
  matchedTerms?: string[]
  phrase?: string
  context?: string
  startMs?: number
  endMs?: number
  result?: string
  resolution?: string
  transcriptLanguage?: string
  transcriptSource?: string
  jev?: unknown
  [key: string]: unknown
}

export interface DiagnosticViolationEvidence {
  candidateId?: string
  ruleId?: RuleId
  ruleLabel?: string
  hitCount?: number
  matchedTerms: string[]
  phrase?: string
  context?: string
  startMs?: number
  endMs?: number
  youtubeUrl?: string
  resolution?: string
  transcriptLanguage?: string
  transcriptSource?: string
  jev?: unknown
}

export class ScanStorage {
  readonly scanId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}`
  private providerExchanges: TranscriptApiExchange[] = []
  private jevExchanges: JevExchange[] = []
  private analysisTrace: AnalysisTraceEntry[] = []

  constructor(
    readonly mode: ScanStorageMode,
    private readonly rootDir: string,
    private readonly allowDiagnostic: boolean,
  ) {
    if (mode === 'diagnostic' && !allowDiagnostic) {
      throw new Error('Diagnostic storage mode is disabled on this server.')
    }
  }

  recordProvider = (exchange: TranscriptApiExchange): void => {
    if (this.mode === 'diagnostic') this.providerExchanges.push(exchange)
  }

  recordJev = (exchange: JevExchange): void => {
    if (this.mode === 'diagnostic') this.jevExchanges.push(exchange)
  }

  recordAnalysisTrace = (entry: AnalysisTraceEntry): void => {
    if (this.mode === 'diagnostic') this.analysisTrace.push(entry)
  }

  private buildDiagnosticResult(result: ChannelCheckResponse): unknown {
    const finalResolutions = this.analysisTrace.filter(
      (entry) => entry.event === 'candidate.final_resolution' && entry.videoId,
    )
    const finalViolations = finalResolutions.filter(
      (entry) => entry.resolution !== 'dismissed',
    )

    const mapEvidence = (entry: AnalysisTraceEntry, videoId: string): DiagnosticViolationEvidence => ({
      candidateId: entry.candidateId,
      ruleId: entry.ruleId,
      ruleLabel: entry.ruleLabel,
      hitCount: entry.hitCount,
      matchedTerms: entry.matchedTerms ?? [],
      phrase: entry.phrase,
      context: entry.context,
      startMs: entry.startMs,
      endMs: entry.endMs,
      youtubeUrl: typeof entry.startMs === 'number'
        ? `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(entry.startMs / 1_000)}s`
        : undefined,
      resolution: entry.resolution as CandidateResolution | undefined,
      transcriptLanguage: entry.transcriptLanguage,
      transcriptSource: entry.transcriptSource,
      jev: entry.jev,
    })

    return {
      ...result,
      videos: result.videos.map((video) => {
        const diagnosticViolations: DiagnosticViolationEvidence[] = finalViolations
          .filter((entry) => entry.videoId === video.id)
          .map((entry) => mapEvidence(entry, video.id))
        const diagnosticEvidence = finalResolutions
          .filter((entry) => entry.videoId === video.id)
          .map((entry) => mapEvidence(entry, video.id))

        return {
          ...video,
          diagnosticViolations,
          diagnosticEvidence,
        }
      }),
      diagnostic: {
        finalViolationCount: finalViolations.length,
        confirmedCount: finalResolutions.filter((entry) => entry.resolution === 'confirmed').length,
        reviewCount: finalResolutions.filter((entry) => entry.resolution === 'needs_review').length,
        dismissedCount: finalResolutions.filter((entry) => entry.resolution === 'dismissed').length,
        note: 'Raw phrase/context evidence is included only because this scan used diagnostic storage mode.',
      },
    }
  }

  async save(result: ChannelCheckResponse): Promise<void> {
    if (this.mode === 'none') return

    const directory = `${this.rootDir.replace(/\/$/, '')}/${this.scanId}`
    await mkdir(directory, { recursive: true })

    const storedResult = this.mode === 'diagnostic'
      ? this.buildDiagnosticResult(result)
      : result

    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(storedResult, null, 2) + '\n',
      'utf8',
    )

    if (this.mode === 'diagnostic') {
      await Promise.all([
        writeFile(
          `${directory}/transcriptapi-exchanges.json`,
          JSON.stringify(this.providerExchanges, null, 2) + '\n',
          'utf8',
        ),
        writeFile(
          `${directory}/jev-exchanges.json`,
          JSON.stringify(this.jevExchanges, null, 2) + '\n',
          'utf8',
        ),
        writeFile(
          `${directory}/analysis-trace.json`,
          JSON.stringify(this.analysisTrace, null, 2) + '\n',
          'utf8',
        ),
      ])
    }
  }
}
