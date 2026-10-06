import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIAnalysisError, OpenAIAnalysisProvider, type OpenAICoverageResult, type OpenAIReviewResult } from '../server/services/openai-analysis'
import { coverageEnabledForProfile } from '../server/services/openai-analysis-stack'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { notReviewedReview } from '../server/domain/content-review-state'
import type { ClassifiedContentEvent } from '../shared/types/content'

const transcript = normalizeTranscript([{ text: 'Отпусти меня.', startMs: 1000, endMs: 2000 }])
const event: ClassifiedContentEvent = {
  category: 'scary_and_disturbing', subtype: 'confinement', severity: 'high', context: 'fiction',
  confidence: 0.95, startMs: 1000, endMs: 2000, text: 'Отпусти меня.', reason: 'Возможное удержание.',
  evidenceStrength: 'explicit', evidenceSource: 'transcript', engagementLevel: 'depiction', portrayal: 'neutral',
  explicitness: 'none', assertionStatus: 'actual',
  details: { fearIntensity: 'strong', themePresent: true, threatPresent: true, supernatural: false },
  review: { ...notReviewedReview('coverage proposal'), status: 'confirmed', evidenceSufficiency: 'sufficient', recommendedParentRelevance: 'high' },
}
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
const proposal: OpenAICoverageResult = {
  rescuedEvents: [event], rescuedCandidates: 1, rejectedCandidates: 0, requestCount: 1,
  usage, provider: { latencyMs: 10 },
  requestMetadata: { model: 'test', reasoningEffort: 'low', transcriptLanguage: 'ru', enabledCategories: ['scary_and_disturbing'], promptVersion: 'test', schemaVersion: 'test', stage: 'coverage' },
}
function reviewed(events: ClassifiedContentEvent[]): OpenAIReviewResult {
  return { reviewedEvents: events, decisions: [], totalCandidates: 1, reviewedCandidates: 1,
    rejectedCandidates: events.length === 0 ? 1 : 0, uncertainCandidates: 0, complete: true,
    requestCount: 2, retryCount: 1, missingBeforeRetry: 1, missingAfterRetry: 0,
    rescuedCandidates: 0, rescueRejectedCandidates: 0, rescuedEvents: [], usage,
    provider: { latencyMs: 20 }, requestMetadata: { ...proposal.requestMetadata, stage: 'review' } }
}
function setup() {
  const provider = new OpenAIAnalysisProvider('test-key', 'test')
  vi.spyOn(provider, 'coverage').mockResolvedValue(proposal)
  return provider
}

afterEach(() => vi.unstubAllEnvs())
describe('verified coverage', () => {
  it.each(['repeated', 'single'] as const)('requires more than a single distress phrase for moderate rescue: %s', async repetition => {
    const parse = vi.fn().mockResolvedValue({ status: 'completed', output_text: '{}', usage: {}, output_parsed: {
      missedHighPriorityEvents: [{
        event: { ...event, candidateId: 'proposal', sceneId: 'scene', category: 'violence', subtype: 'dangerous_situation',
          details: { harmLevel: 'implied', targetType: 'person', weaponRole: 'none', actionPurpose: 'unknown' },
          evidenceSegments: [0], sceneStartSegment: 0, sceneEndSegment: 0 },
        parentRelevance: 'moderate', evidenceSufficiency: 'sufficient', contextSegments: [],
        actor: 'Жители', target: 'Персонаж', aggressionDirection: 'actor_to_target', intent: 'unclear',
        distress: 'clear', consequence: 'unclear', duration: 'brief', repetition,
        narrativeFraming: 'unclear', parentSummary: 'Персонаж просит прекратить происходящее.',
        mitigatingContext: null, highPriorityReason: null, rationale: 'Test structural gate.',
      }],
    } })
    const provider = new OpenAIAnalysisProvider('test', 'test', undefined, { responses: { parse } } as never)
    const result = await provider.coverage(transcript, 'ru', ['violence'], [])
    expect(result.rescuedEvents).toHaveLength(repetition === 'repeated' ? 1 : 0)
    if (repetition === 'repeated') expect(result.rescuedEvents[0]?.review?.recommendedParentRelevance).toBe('moderate')
  })

  it('requires opt-in in normal mode and retains diagnostic coverage', () => {
    vi.stubEnv('OPENAI_COVERAGE_ENABLED', 'false')
    expect(coverageEnabledForProfile('normal')).toBe(false)
    expect(coverageEnabledForProfile('diagnostic')).toBe(true)
    vi.stubEnv('OPENAI_COVERAGE_ENABLED', 'true')
    expect(coverageEnabledForProfile('normal')).toBe(true)
  })

  it('does not publish a proposal rejected by separate review or prime that review with confirmed/high', async () => {
    const provider = setup()
    const review = vi.spyOn(provider, 'review').mockResolvedValue(reviewed([]))
    const schedule = vi.fn(async <T>(task: () => Promise<T>) => task())
    const result = await provider.verifiedCoverage(transcript, 'ru', ['scary_and_disturbing'], [], schedule)
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(review.mock.calls[0]![3][0]!.review).toBeUndefined()
    expect(result.rescuedEvents).toEqual([])
    expect(result).toMatchObject({ verificationComplete: true, rescuedCandidates: 0, rejectedCandidates: 1, requestCount: 3 })
    expect(result.usage.totalTokens).toBe(30)
  })

  it('uses the corrected event and relevance from verification', async () => {
    const provider = setup()
    const corrected = { ...event, review: { ...event.review!, status: 'corrected' as const, recommendedParentRelevance: 'low' as const } }
    vi.spyOn(provider, 'review').mockResolvedValue(reviewed([corrected]))
    const result = await provider.verifiedCoverage(transcript, 'ru', ['scary_and_disturbing'], [])
    expect(result.rescuedEvents[0]?.review?.recommendedParentRelevance).toBe('low')
  })

  it('retains an explicitly unverified finding and usage on reviewer failure', async () => {
    const provider = setup()
    const error = new OpenAIAnalysisError('timeout', 'test timeout')
    error.usage = usage
    error.requestCount = 2
    vi.spyOn(provider, 'review').mockRejectedValue(error)
    const result = await provider.verifiedCoverage(transcript, 'ru', ['scary_and_disturbing'], [])
    expect(result.verificationComplete).toBe(false)
    expect(result.rescuedEvents[0]?.review?.status).toBe('not_reviewed')
    expect(result.requestCount).toBe(3)
    expect(result.usage.totalTokens).toBe(30)
  })

  it('skips verification when no proposals were found', async () => {
    const provider = setup()
    vi.mocked(provider.coverage).mockResolvedValue({ ...proposal, rescuedCandidates: 0, rescuedEvents: [] })
    const review = vi.spyOn(provider, 'review')
    const result = await provider.verifiedCoverage(transcript, 'ru', ['scary_and_disturbing'], [event])
    expect(review).not.toHaveBeenCalled()
    expect(result).toMatchObject({ verificationComplete: true, requestCount: 1 })
  })
})
