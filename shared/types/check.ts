import type {
  AnalysisProfile,
  ChannelCategoryReport,
  ContentCategory,
  ContentCandidate,
  ContentEvent,
  LegacyRuleId,
  PresentationScene,
  RejectedContentCandidate,
  RuleSeverity,
  VideoCategoryReport,
} from './content'
import { ANALYSIS_PROFILES, CONTENT_CATEGORIES, LEGACY_RULE_IDS } from './content'

export {
  ANALYSIS_PROFILES,
  CONTENT_CATEGORIES,
  LEGACY_RULE_IDS,
}
export type * from './content'

export const RULE_IDS = [...CONTENT_CATEGORIES, ...LEGACY_RULE_IDS] as const
export const SELECTABLE_RULE_IDS = CONTENT_CATEGORIES
export const SCAN_STORAGE_MODES = ['none', 'minimal', 'diagnostic'] as const

export type RuleId = ContentCategory | LegacyRuleId
export type ScanStorageMode = (typeof SCAN_STORAGE_MODES)[number]
export type TranscriptUnavailableReason =
  | 'not_available' | 'rate_limited' | 'billing' | 'provider_timeout' | 'provider_error'
export type AnalysisErrorType =
  | 'authentication' | 'rate_limit' | 'timeout' | 'server' | 'schema' | 'provider'

export interface ViolationEvidence {
  category: RuleId
  severity: RuleSeverity
  context: 'realistic' | 'game' | 'fantasy' | 'cartoon' | 'verbal' | 'educational' | 'idiom' | 'other'
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
  cachedTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export interface AggregateOpenAIUsage extends OpenAIUsage {
  requests: number
}

export type ContentReviewRunStatus = 'not_needed' | 'completed' | 'partial' | 'failed' | 'skipped_after_failure'

export interface VideoContentReview {
  status: ContentReviewRunStatus
  candidateCount: number
  reviewedCount: number
  rejectedCount: number
  uncertainCount: number
  model?: string
  promptVersion?: string
  schemaVersion?: string
  latencyMs?: number
  error?: { type: AnalysisErrorType; message: string }
}

export interface OpenAIStageUsage {
  detection: AggregateOpenAIUsage
  review: AggregateOpenAIUsage
}

export interface ContentReviewSummary {
  model: string
  promptVersion: string
  schemaVersion: string
  completedVideos: number
  partialVideos: number
  failedVideos: number
  skippedVideos: number
  notNeededVideos: number
}

export interface TimelineRange { startMs: number; endMs: number }

export interface RuleDetection {
  ruleId: RuleId
  label: string
  severity: RuleSeverity
  count: number
  ranges: TimelineRange[]
}

export interface SpeechQualityMarkerCount {
  marker: string
  count: number
}

export type SpeechPatternFrequency = 'none' | 'occasional' | 'noticeable' | 'frequent'

export interface SpeechQualityInterpretation {
  fillerFrequency: SpeechPatternFrequency
  repetitionFrequency: SpeechPatternFrequency
  fillerEveryWords?: number
  repetitionEveryWords?: number
  summary: string
  note: string
}

export interface SpeechQualityExample {
  marker: string
  startMs: number
  endMs: number
  text: string
}

export interface SpeechQualityMetrics {
  method: 'heuristic_ru_v1' | 'repetition_only_v1'
  language: string
  totalWords: number
  fillerWordCount: number
  fillersPer1000Words: number
  repeatedWordCount: number
  repeatedWordsPer1000Words: number
  fillerBreakdown: SpeechQualityMarkerCount[]
  examples: SpeechQualityExample[]
  interpretation: SpeechQualityInterpretation
}

export interface ChannelSpeechQualitySummary {
  totalWords: number
  fillerWordCount: number
  fillersPer1000Words: number
  repeatedWordCount: number
  repeatedWordsPer1000Words: number
  fillerBreakdown: SpeechQualityMarkerCount[]
  analyzedVideos: number
  asrVideos: number
  interpretation: SpeechQualityInterpretation
}

export interface VideoMetadata {
  id: string
  title: string
  publishedAt: string
  thumbnailUrl?: string

  // TranscriptAPI /youtube/info currently returns a language hint only.
  // A plain code such as "ru" does not prove that a human-made track exists.
  preflightCaptionLanguage?: string

  // Deprecated compatibility alias from the previous result contract.
  expectedCaptionLanguage?: string
}

export interface ChannelMetadata { id: string; title: string; thumbnailUrl?: string }

export type CaptionSource = 'manual' | 'asr' | 'unknown'
export type CaptionLanguageResolution =
  | 'exact'
  | 'same_language_asr'
  | 'same_language_variant'
  | 'different_language'
  | 'unknown'

export interface VideoScanResult extends VideoMetadata {
  status: 'analyzed' | 'transcript_unavailable' | 'provider_error'
  url: string
  transcriptLanguage?: string
  captionSource?: CaptionSource
  captionLanguageResolution?: CaptionLanguageResolution

  // Deprecated. A plain preflight language resolving to ASR is not a provider failure.
  captionSourceMismatch?: boolean
  unavailableReason?: TranscriptUnavailableReason
  analysisError?: { type: AnalysisErrorType; status?: number; code?: string; message: string }
  openaiUsage?: OpenAIUsage
  contentReview?: VideoContentReview
  speechQuality?: SpeechQualityMetrics

  // Legacy compatibility. New consumers should use contentEvents/videoReports.
  violations: ViolationEvidence[]
  detections: RuleDetection[]
}

export interface RuleSummary {
  ruleId: RuleId
  label: string
  severity: RuleSeverity | null
  violationCount: number
  affectedVideoCount: number
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

export interface VideoContentReport {
  videoId: string
  categoryReports: VideoCategoryReport[]
  scenes: PresentationScene[]
  contentSummary?: string
  mainSceneCount?: number
  detailSceneCount?: number
  candidates?: ContentCandidate[]
  rejectedCandidates?: RejectedContentCandidate[]
}

export interface ChannelCheckResponse {
  scanId?: string
  storageMode: ScanStorageMode
  profile: AnalysisProfile
  channel: ChannelMetadata
  requestedVideos: number
  analyzedVideos: number
  failedVideos: number
  analysisMode: 'openai'
  creditUsage: ScanCreditUsage
  openaiUsage: AggregateOpenAIUsage
  openaiStages?: OpenAIStageUsage
  contentReview?: ContentReviewSummary

  // Separate secondary analysis dimension; never part of content-safety categories.
  speechQuality: ChannelSpeechQualitySummary

  selection: ScanSelection

  // New canonical content-safety architecture.
  contentEvents: ContentEvent[]
  videoReports: VideoContentReport[]
  channelReport: ChannelCategoryReport[]

  // Legacy compatibility. Derived from contentEvents.
  summary: RuleSummary[]
  videos: VideoScanResult[]

  limitations: string[]
}
