export const RULE_IDS = [
  'profanity',
  'insults',
  'toilet_humor',
  'gambling',
  'sexual_content',
  'violence',
  'alcohol_drugs',
] as const

export type RuleId = (typeof RULE_IDS)[number]
export type RuleSeverity = 'low' | 'medium' | 'high'

export interface TranscriptSegment {
  text: string
  offsetMs: number
  durationMs: number
  lang?: string
}

export interface RuleViolation {
  ruleId: RuleId
  label: string
  severity: RuleSeverity
  timestampMs: number
  excerpt: string
  matches: string[]
  count: number
}

export interface VideoMetadata {
  id: string
  title: string
  publishedAt: string
  thumbnailUrl?: string
}

export interface ChannelMetadata {
  id: string
  title: string
  uploadsPlaylistId: string
  thumbnailUrl?: string
}

export interface VideoScanResult extends VideoMetadata {
  status: 'analyzed' | 'transcript_unavailable'
  transcriptLanguage?: string
  violations: RuleViolation[]
  error?: string
}

export interface RuleSummary {
  ruleId: RuleId
  label: string
  severity: RuleSeverity
  hitCount: number
  videoCount: number
}

export interface ChannelCheckResponse {
  channel: Omit<ChannelMetadata, 'uploadsPlaylistId'>
  requestedVideos: number
  analyzedVideos: number
  failedVideos: number
  summary: RuleSummary[]
  videos: VideoScanResult[]
  limitations: string[]
}
