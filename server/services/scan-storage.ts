import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChannelCheckResponse, ScanStorageMode } from '../../shared/types/check'
import type { ContentEvent } from '../../shared/types/content'
import type { TranscriptApiExchange } from './transcript-api'
import type { OpenAIAnalysisError, OpenAIAnalysisResult } from './openai-analysis'

interface OpenAIDiagnosticEntry {
  videoId: string
  normalizedTranscript: string
  requestMetadata: OpenAIAnalysisResult['requestMetadata']
  provider?: OpenAIAnalysisResult['provider']
  parsedResult?: {
    modelOutputText?: string
    classifiedEvents: OpenAIAnalysisResult['classifiedEvents']
    rejectedCandidates?: OpenAIAnalysisResult['rejectedCandidates']
    normalizedContentEvents?: ContentEvent[]
  }
  usage?: OpenAIAnalysisResult['usage']
  error?: { type: string; status?: number; code?: string; message: string }
  outputText?: string
}

export class ScanStorage {
  readonly scanId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}`
  private providerExchanges: TranscriptApiExchange[] = []
  private openaiEntries: OpenAIDiagnosticEntry[] = []

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

  recordOpenAISuccess(
    videoId: string,
    result: OpenAIAnalysisResult,
    normalizedTranscript: string,
    normalizedContentEvents: ContentEvent[] = [],
  ): void {
    if (this.mode !== 'diagnostic') return
    this.openaiEntries.push({
      videoId,
      normalizedTranscript,
      requestMetadata: result.requestMetadata,
      provider: result.provider,
      parsedResult: {
        modelOutputText: result.outputText,
        classifiedEvents: result.classifiedEvents,
        rejectedCandidates: result.rejectedCandidates,
        normalizedContentEvents,
      },
      usage: result.usage,
    })
  }

  recordOpenAIError(
    videoId: string,
    error: OpenAIAnalysisError,
    requestMetadata: OpenAIAnalysisResult['requestMetadata'],
    normalizedTranscript: string,
  ): void {
    if (this.mode !== 'diagnostic') return
    this.openaiEntries.push({
      videoId,
      normalizedTranscript,
      requestMetadata,
      provider: error.provider,
      usage: error.usage,
      outputText: error.outputText,
      error: {
        type: error.type,
        status: error.status,
        code: error.code,
        message: error.message,
      },
    })
  }

  private withoutEvidenceText(event: ContentEvent): Record<string, unknown> {
    const { text: _text, ...rest } = event
    return rest
  }

  private buildMinimalResult(result: ChannelCheckResponse): unknown {
    return {
      ...result,
      contentEvents: result.contentEvents.map((event) => this.withoutEvidenceText(event)),
      videoReports: result.videoReports.map(({ candidates: _candidates, rejectedCandidates: _rejected, ...report }) => ({
        ...report,
        categoryReports: report.categoryReports.map((categoryReport) => ({
          ...categoryReport,
          highlights: categoryReport.highlights.map((event) => this.withoutEvidenceText(event)),
          details: categoryReport.details.map((event) => this.withoutEvidenceText(event)),
        })),
        scenes: report.scenes.map((scene) => ({
          ...scene,
          events: scene.events.map((event) => this.withoutEvidenceText(event)),
        })),
      })),
      videos: result.videos.map((video) => ({
        ...video,
        speechQuality: video.speechQuality
          ? {
              ...video.speechQuality,
              examples: video.speechQuality.examples.map(({ text: _text, ...example }) => example),
            }
          : undefined,
        violations: video.violations.map(({ text: _text, ...violation }) => violation),
      })),
    }
  }

  private buildDiagnosticResult(result: ChannelCheckResponse): unknown {
    return {
      ...result,
      videos: result.videos.map((video) => {
        const entry = this.openaiEntries.find((item) => item.videoId === video.id)
        return entry?.parsedResult
          ? {
              ...video,
              rejectedCandidates: entry.parsedResult.rejectedCandidates ?? [],
              classifiedEvents: entry.parsedResult.classifiedEvents,
              normalizedContentEvents: entry.parsedResult.normalizedContentEvents ?? [],
            }
          : video
      }),
      diagnostic: {
        note: 'Diagnostic mode retains transcript, LLM classifications/rejections, normalized ContentEvents, policy decisions and aggregation outputs for traceability.',
      },
    }
  }

  async save(result: ChannelCheckResponse): Promise<void> {
    if (this.mode === 'none') return
    const directory = `${this.rootDir.replace(/\/$/, '')}/${this.scanId}`
    await mkdir(directory, { recursive: true })
    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(
        this.mode === 'diagnostic' ? this.buildDiagnosticResult(result) : this.buildMinimalResult(result),
        null,
        2,
      ) + '\n',
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
          `${directory}/openai-analysis.json`,
          JSON.stringify(this.openaiEntries, null, 2) + '\n',
          'utf8',
        ),
      ])
    }
  }
}
