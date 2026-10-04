export const CONTENT_CATEGORIES = [
  'profanity_and_rude_language',
  'insults',
  'toilet_humor',
  'violence',
  'scary_and_disturbing',
  'sexual_content',
  'gambling',
  'substances',
  'self_harm',
] as const

export const LEGACY_RULE_IDS = ['alcohol_and_drugs', 'tobacco_and_nicotine'] as const
export const ANALYSIS_PROFILES = ['normal', 'strict', 'diagnostic'] as const

export type ContentCategory = (typeof CONTENT_CATEGORIES)[number]
export type LegacyRuleId = (typeof LEGACY_RULE_IDS)[number]
export type AnalysisProfile = (typeof ANALYSIS_PROFILES)[number]
export type RuleSeverity = 'low' | 'medium' | 'high'
export type ParentRelevance = 'minimal' | 'low' | 'moderate' | 'high'
export type DisplayLevel = 'hidden' | 'summary' | 'highlight'
export type ReportLevel = 'none' | 'low' | 'moderate' | 'high'
export type EvidenceStrength = 'explicit' | 'strong_context' | 'weak_context'
export type EvidenceSource = 'transcript' | 'title' | 'description' | 'metadata'
export type ContentContext = 'game' | 'fiction' | 'real_world' | 'educational' | 'unknown'
export type EngagementLevel = 'mention' | 'depiction' | 'participation' | 'encouragement' | 'instruction'
export type Portrayal = 'neutral' | 'normalized' | 'glamorized' | 'discouraged' | 'educational' | 'humorous' | 'unknown'
export type Explicitness = 'none' | 'mild' | 'explicit' | 'graphic'
export type AssertionStatus = 'actual' | 'threatened' | 'hypothetical' | 'negated' | 'reported'
export type ViolenceActionPurpose = 'attack' | 'threat' | 'defense' | 'rescue' | 'utility' | 'sport' | 'demonstration' | 'accident' | 'destruction' | 'unknown'
export type PrevalenceLevel = 'none' | 'rare' | 'occasional' | 'common' | 'pervasive'

export type ContentReviewStatus = 'confirmed' | 'corrected' | 'uncertain' | 'not_reviewed'
export type ReviewEvidenceSufficiency = 'insufficient' | 'partial' | 'sufficient'
export type AggressionDirection = 'none' | 'actor_to_target' | 'mutual' | 'self_directed' | 'unclear'
export type SceneIntent = 'benign' | 'rescue' | 'protective' | 'utility' | 'accidental' | 'aggressive' | 'coercive' | 'unclear'
export type DistressLevel = 'none' | 'mild' | 'clear' | 'strong' | 'unclear'
export type ConsequenceLevel =
  | 'none'
  | 'property_only'
  | 'threatened_harm'
  | 'injury_or_severe_harm'
  | 'death'
  | 'unclear'
export type SceneDuration = 'momentary' | 'brief' | 'sustained' | 'unclear'
export type RepetitionLevel = 'single' | 'repeated' | 'pattern' | 'unclear'
export type NarrativeFraming = 'discouraged' | 'neutral' | 'humorous' | 'endorsed' | 'unclear'

export interface ContentEventReview {
  status: ContentReviewStatus
  recommendedParentRelevance: ParentRelevance
  evidenceSufficiency: ReviewEvidenceSufficiency
  contextRanges: Array<{ startMs: number; endMs: number }>
  actor?: string
  target?: string
  aggressionDirection: AggressionDirection
  intent: SceneIntent
  distress: DistressLevel
  consequence: ConsequenceLevel
  duration: SceneDuration
  repetition: RepetitionLevel
  narrativeFraming: NarrativeFraming
  rationale: string
}

export interface ParentPolicyPreferences {
  childAge?: number
  sensitivities?: Partial<Record<ContentCategory, 'default' | 'sensitive' | 'less_sensitive'>>
}

export type ProfanitySubtype = 'profanity' | 'rude_language' | 'slur' | 'obscene_expression'
export type InsultSubtype = 'direct_insult' | 'mockery' | 'humiliating_name' | 'degrading_statement'
export type ToiletHumorSubtype = 'toilet_reference' | 'toilet_joke' | 'bodily_function' | 'gross_out_humor'
export type ViolenceSubtype =
  | 'weapon_presence'
  | 'weapon_use'
  | 'violent_threat'
  | 'physical_attack'
  | 'fantasy_combat'
  | 'dangerous_situation'
  | 'life_threatening_situation'
  | 'destruction'
  | 'injury'
  | 'death'
  | 'graphic_violence'
export type ScarySubtype =
  | 'threatening_character'
  | 'pursuit'
  | 'horror_theme'
  | 'jump_scare'
  | 'disturbing_theme'
  | 'death_related_theme'
  | 'confinement'
  | 'intense_peril'
  | 'other'
export type SexualSubtype =
  | 'romantic_reference'
  | 'suggestive_reference'
  | 'sexual_joke'
  | 'sexual_discussion'
  | 'sexual_behavior'
  | 'explicit_sexual_content'
export type GamblingSubtype =
  | 'mention'
  | 'simulated_gambling'
  | 'real_money_gambling'
  | 'betting'
  | 'promotion'
  | 'instruction'
export type SubstanceSubtype = 'alcohol' | 'nicotine' | 'drugs' | 'medication_misuse' | 'other'
export type SelfHarmSubtype =
  | 'self_injury_reference'
  | 'self_injury_act'
  | 'suicidal_ideation'
  | 'suicide_threat'
  | 'suicide_attempt'
  | 'suicide_death'
  | 'encouragement'
  | 'instruction'
  | 'joke_or_casual_reference'

export interface ProfanityDetails {
  /** Exact lexical evidence; optional for previously stored events. */
  expression?: string
  targeted: boolean
}

export interface InsultDetails {
  targetType: 'person' | 'character' | 'group' | 'self' | 'unknown'
}

export interface ToiletHumorDetails {
  physiological: boolean
}

export interface ViolenceDetails {
  harmLevel: 'none' | 'threatened' | 'attempted' | 'implied' | 'actual'
  targetType:
    | 'person'
    | 'human_like_character'
    | 'animal'
    | 'fantasy_creature'
    | 'environment'
    | 'object'
    | 'unknown'
  weaponRole: 'none' | 'mentioned' | 'possessed' | 'threatened_use' | 'used'
  actionPurpose: ViolenceActionPurpose
}

export interface ScaryDetails {
  /** Whether the evidence establishes a theme, independent of literal harm. */
  themePresent?: boolean
  fearIntensity: 'mild' | 'moderate' | 'strong'
  threatPresent: boolean
  supernatural: boolean
}

export interface SexualDetails {
  sexualExplicitness: 'none' | 'suggestive' | 'explicit'
}

export interface GamblingDetails {
  stakePresent: boolean
  valueType: 'none' | 'virtual' | 'real' | 'unknown'
}

export interface SubstanceDetails {
  substance: SubstanceSubtype
  action: 'mention' | 'presence' | 'use' | 'purchase' | 'promotion' | 'encouragement' | 'instruction'
  userType: 'adult' | 'minor' | 'fictional_character' | 'unknown'
}

export interface SelfHarmDetails {
  intentionality: 'unclear' | 'implied' | 'explicit'
  actionStatus: 'reference' | 'threat' | 'attempt' | 'actual'
  encouragement: 'none' | 'positive' | 'instructional'
}

export interface ContentDetailsByCategory {
  profanity_and_rude_language: ProfanityDetails
  insults: InsultDetails
  toilet_humor: ToiletHumorDetails
  violence: ViolenceDetails
  scary_and_disturbing: ScaryDetails
  sexual_content: SexualDetails
  gambling: GamblingDetails
  substances: SubstanceDetails
  self_harm: SelfHarmDetails
}

export interface BaseContentEvent {
  id: string
  sourceCandidateId?: string
  sceneId?: string
  category: ContentCategory
  subtype: string
  severity: RuleSeverity
  context: ContentContext
  confidence: number
  startMs: number
  endMs: number
  evidenceRanges?: Array<{ startMs: number; endMs: number }>
  sceneStartMs?: number
  sceneEndMs?: number
  text: string
  reason: string
  evidenceStrength: EvidenceStrength
  evidenceSource: EvidenceSource
  engagementLevel?: EngagementLevel
  portrayal?: Portrayal
  explicitness?: Explicitness
  assertionStatus: AssertionStatus
  review?: ContentEventReview
  parentRelevance: ParentRelevance
  displayLevel: DisplayLevel
}

export type ContentEvent = {
  [C in ContentCategory]: BaseContentEvent & {
    category: C
    subtype:
      C extends 'profanity_and_rude_language' ? ProfanitySubtype
        : C extends 'insults' ? InsultSubtype
          : C extends 'toilet_humor' ? ToiletHumorSubtype
            : C extends 'violence' ? ViolenceSubtype
              : C extends 'scary_and_disturbing' ? ScarySubtype
                : C extends 'sexual_content' ? SexualSubtype
                  : C extends 'gambling' ? GamblingSubtype
                    : C extends 'substances' ? SubstanceSubtype
                      : C extends 'self_harm' ? SelfHarmSubtype
                        : never
    details: ContentDetailsByCategory[C]
  }
}[ContentCategory]

export type ClassifiedContentEvent = {
  [C in ContentCategory]: Omit<
    Extract<ContentEvent, { category: C }>,
    'id' | 'parentRelevance' | 'displayLevel'
  >
}[ContentCategory]

export interface ContentCandidate {
  candidateId: string
  sceneId?: string
  suspectedCategory: ContentCategory
  startMs: number
  endMs: number
  text: string
}

export interface RejectedContentCandidate extends ContentCandidate {
  reason: string
}

export interface CategoryReport {
  category: ContentCategory
  label: string
  level: ReportLevel
  rawEventCount: number
  displayedEventCount: number
  subtypes: string[]
  summary: string
  highlights: ContentEvent[]
  details: ContentEvent[]
}

export interface VideoCategoryReport extends CategoryReport {}

export interface ChannelSubtypeStat {
  subtype: string
  eventCount: number
  videoCount: number
}

export interface ChannelCategoryReport {
  category: ContentCategory
  label: string
  level: ReportLevel
  peakConcern: ReportLevel
  prevalence: PrevalenceLevel
  affectedRatio: number
  moderatePlusPrevalence: PrevalenceLevel
  moderatePlusAffectedRatio: number
  moderatePlusAffectedVideos: number
  analyzedVideos: number
  rawAffectedVideos: number
  affectedVideos: number
  highlightedVideos: number
  rawEventCount: number
  displayedEventCount: number
  subtypeStats: ChannelSubtypeStat[]
  summary: string
}

export interface PresentationScene {
  sceneId: string
  startMs: number
  endMs: number
  level: ReportLevel
  attention: 'main' | 'details'
  reviewStatus: 'reviewed' | 'mixed' | 'unreviewed'
  categories: ContentCategory[]
  evidenceRanges: Array<{ startMs: number; endMs: number }>
  label: string
  summary: string
  events: ContentEvent[]
}
