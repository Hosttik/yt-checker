export const RULE_IDS = [
  'profanity',
  'insults',
  'toilet_humor',
  'gambling',
  'sexual_content',
  'violence',
  'alcohol_drugs',
] as const

export const SCAN_STORAGE_MODES = ['none', 'minimal', 'diagnostic'] as const

export type RuleId = (typeof RULE_IDS)[number]
export type ScanStorageMode = (typeof SCAN_STORAGE_MODES)[number]
export type RuleSeverity = 'low' | 'medium' | 'high'
export type CandidateResolution = 'confirmed' | 'needs_review' | 'dismissed'
export type TranscriptUnavailableReason =
  | 'not_available'
  | 'rate_limited'
  | 'billing'
  | 'provider_timeout'
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
  confirmedCount: number
  reviewCount: number
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
  confirmedCount: number
  reviewCount: number
  videoCount: number
}

export interface ScanCreditUsage {
  transcriptCredits: number
  channelVideosCredits: number
  totalCredits: number
  freeRequests: number
}

export interface ScanSelection {
  targetVideos: number
  inspectedVideos: number
  captionEligibleVideos: number
  /** Backward-compatible alias for transcriptVideosAttempted. */
  transcriptAttempts: number
  transcriptVideosAttempted: number
  transcriptHttpRequests: number
  usedChannelVideosFallback: boolean
  requestedLanguage: string
}

export interface ChannelCheckResponse {
  scanId?: string
  storageMode: ScanStorageMode
  channel: ChannelMetadata
  requestedVideos: number
  analyzedVideos: number
  failedVideos: number
  analysisMode: 'regex_only' | 'regex_jev'
  contextualFallbackVideos: number
  creditUsage: ScanCreditUsage
  selection: ScanSelection
  summary: RuleSummary[]
  videos: VideoScanResult[]
  limitations: string[]
}
