import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChannelCheckResponse, ScanStorageMode } from '../../shared/types/check'
import type { TranscriptApiExchange } from './transcript-api'
import type { OpenAIAnalysisError, OpenAIAnalysisResult } from './openai-analysis'

interface OpenAIDiagnosticEntry {
  videoId: string
  normalizedTranscript: string
  requestMetadata: OpenAIAnalysisResult['requestMetadata']
  provider?: OpenAIAnalysisResult['provider']
  parsedResult?: {
    violations: OpenAIAnalysisResult['violations']
    rejectedCandidates?: OpenAIAnalysisResult['rejectedCandidates']
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

  recordOpenAISuccess(videoId: string, result: OpenAIAnalysisResult, normalizedTranscript: string): void {
    if (this.mode !== 'diagnostic') return
    this.openaiEntries.push({
      videoId,
      normalizedTranscript,
      requestMetadata: result.requestMetadata,
      provider: result.provider,
      parsedResult: {
        violations: result.violations,
        rejectedCandidates: result.rejectedCandidates,
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

  private buildDiagnosticResult(result: ChannelCheckResponse): unknown {
    return {
      ...result,
      videos: result.videos.map((video) => {
        const entry = this.openaiEntries.find((item) => item.videoId === video.id)
        return entry?.parsedResult?.rejectedCandidates
          ? { ...video, rejectedCandidates: entry.parsedResult.rejectedCandidates }
          : video
      }),
      diagnostic: {
        note: 'Normalized transcripts and compact provider diagnostics are stored only because diagnostic mode was explicitly enabled.',
      },
    }
  }

  async save(result: ChannelCheckResponse): Promise<void> {
    if (this.mode === 'none') return
    const directory = `${this.rootDir.replace(/\/$/, '')}/${this.scanId}`
    await mkdir(directory, { recursive: true })
    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(this.mode === 'diagnostic' ? this.buildDiagnosticResult(result) : result, null, 2) + '\n',
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
