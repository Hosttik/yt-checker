export const RULE_IDS = [
  'profanity_and_rude_language',
  'insults',
  'toilet_humor',
  'gambling',
  'sexual_content',
  'violence',
  'alcohol_and_drugs',
] as const

export const SCAN_STORAGE_MODES = ['none', 'minimal', 'diagnostic'] as const
export const VIOLATION_CONTEXTS = [
  'realistic', 'game', 'fantasy', 'cartoon', 'verbal', 'educational', 'idiom', 'other',
] as const

export type RuleId = (typeof RULE_IDS)[number]
export type ScanStorageMode = (typeof SCAN_STORAGE_MODES)[number]
export type RuleSeverity = 'low' | 'medium' | 'high'
export type ViolationContext = (typeof VIOLATION_CONTEXTS)[number]
export type TranscriptUnavailableReason =
  | 'not_available' | 'rate_limited' | 'billing' | 'provider_timeout' | 'provider_error'
export type AnalysisErrorType =
  | 'authentication' | 'rate_limit' | 'timeout' | 'server' | 'schema' | 'provider'

export interface ViolationEvidence {
  category: RuleId
  severity: RuleSeverity
  context: ViolationContext
  type: 'profanity' | 'rude_language' | 'not_applicable'
  startMs: number
  endMs: number
  text: string
  reason: string
}

export interface RejectedCandidate {
  category: RuleId
  startMs: number
  endMs: number
  text: string
  reason: string
}

export interface OpenAIUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface AggregateOpenAIUsage extends OpenAIUsage {
  requests: number
}

export interface TimelineRange { startMs: number; endMs: number }

export interface RuleDetection {
  ruleId: RuleId
  label: string
  severity: RuleSeverity
  count: number
  confirmedCount: number
  reviewCount: number
  ranges: TimelineRange[]
  evidence: ViolationEvidence[]
}

export interface VideoMetadata {
  id: string
  title: string
  publishedAt: string
  thumbnailUrl?: string
}

export interface ChannelMetadata { id: string; title: string; thumbnailUrl?: string }

export interface VideoScanResult extends VideoMetadata {
  status: 'analyzed' | 'transcript_unavailable' | 'provider_error'
  url: string
  transcriptLanguage?: string
  unavailableReason?: TranscriptUnavailableReason
  analysisError?: { type: AnalysisErrorType; status?: number; code?: string; message: string }
  openaiUsage?: OpenAIUsage
  violations: ViolationEvidence[]
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
  analysisMode: 'openai'
  contextualFallbackVideos: number
  creditUsage: ScanCreditUsage
  openaiUsage: AggregateOpenAIUsage
  selection: ScanSelection
  summary: RuleSummary[]
  videos: VideoScanResult[]
  limitations: string[]
}
