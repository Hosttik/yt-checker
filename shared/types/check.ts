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
export type TranscriptUnavailableReason =
  | 'not_available'
  | 'rate_limited'
  | 'billing'
  | 'provider_error'
export type ContextFilterStatus =
  | 'applied'
  | 'fallback'
  | 'not_needed'
  | 'disabled'

export interface TimelineRange {
  startMs: number
  endMs: number
}

export interface RuleDetection {
  ruleId: RuleId
  label: string
  severity: RuleSeverity
  count: number
  ranges: TimelineRange[]
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
  thumbnailUrl?: string
}

export interface VideoScanResult extends VideoMetadata {
  status: 'analyzed' | 'transcript_unavailable'
  transcriptLanguage?: string
  unavailableReason?: TranscriptUnavailableReason
  contextFilterStatus?: ContextFilterStatus
  detections: RuleDetection[]
}

export interface RuleSummary {
  ruleId: RuleId
  label: string
  severity: RuleSeverity
  hitCount: number
  videoCount: number
}

export interface ChannelCheckResponse {
  channel: ChannelMetadata
  requestedVideos: number
  analyzedVideos: number
  failedVideos: number
  analysisMode: 'regex_only' | 'regex_jev'
  contextualFallbackVideos: number
  summary: RuleSummary[]
  videos: VideoScanResult[]
  limitations: string[]
}
