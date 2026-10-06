import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChannelCheckResponse, ScanStorageMode, VideoContentReview } from '../../shared/types/check'
import type { ContentEvent } from '../../shared/types/content'
import type { ContentValidationAdjustment, ContentValidationRejection } from '../domain/content-validation'
import type { TranscriptApiExchange } from './transcript-api'
import type {
  OpenAIAnalysisError,
  OpenAIAnalysisResult,
  OpenAICoverageResult,
  OpenAIReviewResult,
} from './openai-analysis'

interface OpenAIDiagnosticEntry {
  videoId: string
  normalizedTranscript: string
  normalizedTimeline?: Array<{ startMs: number; endMs: number }>
  requestMetadata: OpenAIAnalysisResult['requestMetadata']
  provider?: OpenAIAnalysisResult['provider']
  parsedResult?: {
    modelOutputText?: string
    classifiedEvents: OpenAIAnalysisResult['classifiedEvents']
    rejectedCandidates?: OpenAIAnalysisResult['rejectedCandidates']
    normalizedContentEvents?: ContentEvent[]
    validationRejections?: ContentValidationRejection[]
    validationAdjustments?: ContentValidationAdjustment[]
    reviewedClassifiedEvents?: OpenAIReviewResult['reviewedEvents']
    reviewDecisions?: OpenAIReviewResult['decisions']
    coverageRescuedEvents?: OpenAICoverageResult['rescuedEvents']
  }
  usage?: OpenAIAnalysisResult['usage']
  review?: {
    status: VideoContentReview
    requestMetadata?: OpenAIReviewResult['requestMetadata']
    provider?: OpenAIReviewResult['provider']
    usage?: OpenAIReviewResult['usage']
    outputText?: string
    error?: { type: string; status?: number; code?: string; message: string }
  }
  coverage?: {
    requestMetadata?: OpenAICoverageResult['requestMetadata']
    provider?: OpenAICoverageResult['provider']
    usage?: OpenAICoverageResult['usage']
    outputText?: string
    rescuedCandidates?: number
    rejectedCandidates?: number
    error?: { type: string; status?: number; code?: string; message: string }
  }
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
    validationRejections: ContentValidationRejection[] = [],
    validationAdjustments: ContentValidationAdjustment[] = [],
    reviewStatus?: VideoContentReview,
    reviewResult?: OpenAIReviewResult,
    reviewError?: OpenAIAnalysisError,
    coverageResult?: OpenAICoverageResult,
    coverageError?: OpenAIAnalysisError,
    normalizedTimeline?: Array<{ startMs: number; endMs: number }>,
  ): void {
    if (this.mode !== 'diagnostic') return
    this.openaiEntries.push({
      videoId,
      normalizedTranscript,
      normalizedTimeline: normalizedTimeline?.map(({ startMs, endMs }) => ({ startMs, endMs })),
      requestMetadata: result.requestMetadata,
      provider: result.provider,
      parsedResult: {
        modelOutputText: result.outputText,
        classifiedEvents: result.classifiedEvents,
        rejectedCandidates: result.rejectedCandidates,
        normalizedContentEvents,
        validationRejections,
        validationAdjustments,
        reviewedClassifiedEvents: reviewResult?.reviewedEvents,
        reviewDecisions: reviewResult?.decisions,
        coverageRescuedEvents: coverageResult?.rescuedEvents,
      },
      usage: result.usage,
      review: reviewStatus
        ? {
            status: reviewStatus,
            requestMetadata: reviewResult?.requestMetadata,
            provider: reviewResult?.provider ?? reviewError?.provider,
            usage: reviewResult?.usage ?? reviewError?.usage,
            outputText: reviewResult?.outputText ?? reviewError?.outputText,
            error: reviewError
              ? {
                  type: reviewError.type,
                  status: reviewError.status,
                  code: reviewError.code,
                  message: reviewError.message,
                }
              : undefined,
          }
        : undefined,
      coverage: coverageResult || coverageError
        ? {
            requestMetadata: coverageResult?.requestMetadata,
            provider: coverageResult?.provider ?? coverageError?.provider,
            usage: coverageResult?.usage ?? coverageError?.usage,
            outputText: coverageResult?.outputText ?? coverageError?.outputText,
            rescuedCandidates: coverageResult?.rescuedCandidates,
            rejectedCandidates: coverageResult?.rejectedCandidates,
            error: coverageError
              ? {
                  type: coverageError.type,
                  status: coverageError.status,
                  code: coverageError.code,
                  message: coverageError.message,
                }
              : undefined,
          }
        : undefined,
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
              validationRejections: entry.parsedResult.validationRejections ?? [],
              validationAdjustments: entry.parsedResult.validationAdjustments ?? [],
              reviewedClassifiedEvents: entry.parsedResult.reviewedClassifiedEvents ?? [],
              reviewDecisions: entry.parsedResult.reviewDecisions ?? [],
              reviewTrace: entry.review,
            }
          : video
      }),
      diagnostic: {
        note: 'Diagnostic storage retains transcript, first-pass classifications, contextual-review decisions/errors, backend semantic-validation rejections/adjustments, normalized ContentEvents, policy decisions and aggregation outputs for traceability. Storage mode does not change classifier output.',
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
