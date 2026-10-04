import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ChannelCheckResponse, ScanStorageMode } from '../../shared/types/check'
import type { TranscriptApiExchange } from './transcript-api'
import type { JevExchange } from './jev-context-filter'

export class ScanStorage {
  readonly scanId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}`
  private providerExchanges: TranscriptApiExchange[] = []
  private jevExchanges: JevExchange[] = []
  private analysisTrace: unknown[] = []

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

  recordAnalysisTrace = (entry: unknown): void => {
    if (this.mode === 'diagnostic') this.analysisTrace.push(entry)
  }

  async save(result: ChannelCheckResponse): Promise<void> {
    if (this.mode === 'none') return

    const directory = `${this.rootDir.replace(/\/$/, '')}/${this.scanId}`
    await mkdir(directory, { recursive: true })
    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(result, null, 2) + '\n',
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
