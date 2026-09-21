/**
 * Raw provider content.
 *
 * This type must stay server-only. Transcript text is processed in memory and
 * must never be persisted, logged, cached, or returned from an API handler.
 */
export interface TranscriptSegment {
  text: string
  startMs: number
  endMs: number
}

export interface TranscriptResult {
  language?: string
  segments: TranscriptSegment[]
}
