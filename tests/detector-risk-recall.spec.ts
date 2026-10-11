import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { uncoveredRiskWindows, isDuplicateRiskRecall } from '../server/domain/detector-risk-recall'
import { BatchedOpenAIAnalyzer } from '../server/services/openai-batched-analyzer'
import type { ClassifiedContentEvent, ContentCategory } from '../shared/types/content'
import type {
  OpenAIAnalysisBatchInput,
  OpenAIAnalysisBatchResult,
  OpenAIAnalysisProvider,
} from '../server/services/openai-analysis'
import { ProviderScheduler } from '../server/utils/provider-scheduler'

// Compact, human-curated excerpts from identical ASR transcripts in the
// 09:21 and 10:04 Compot scans. No full transcript is retained in Git.
function clips() {
  const text = [
    'Ребята, я сегодня ходил в шахту.',
    'Они решили, что Компот умер, хотя он просто спал.',
    'Зомби не существует, но жители думают иначе.',
    'Бежим на склад, берём инструменты, вилы, копья.',
    'Я добыл алмазы и изумруды в шахте.',
    'Он здесь. Он зомби. Ему нельзя доверять.',
    'Жители, что происходит? Почему вы так напуганы?',
    'Достаём вилы и копья.',
    'Помогите, спасите меня, прошу.',
    'Они загнали меня в тупик, что мне делать?',
    'Стойте, жители, остановитесь!',
    'Вы на меня с вилами набросились.',
  ]
  return normalizeTranscript(text.map((line, index) => ({
    text: line,
    startMs: 540_000 + index * 5_000,
    endMs: 544_000 + index * 5_000,
  })))
}

function confirmedThreat(): ClassifiedContentEvent {
  return {
    category: 'violence', subtype: 'violent_threat', severity: 'medium',
    context: 'game', confidence: 0.95, startMs: 575_000, endMs: 595_000,
    evidenceRanges: [{ startMs: 575_000, endMs: 595_000 }],
    text: 'Достаём вилы и копья. Помогите, спасите меня.',
    reason: 'Жители преследуют персонажа с вилами и копьями.',
    evidenceStrength: 'explicit', evidenceSource: 'transcript',
    engagementLevel: 'depiction', portrayal: 'neutral',
    explicitness: 'mild', assertionStatus: 'actual',
    details: {
      harmLevel: 'threatened', targetType: 'human_like_character',
      weaponRole: 'threatened_use', actionPurpose: 'threat',
    },
  }
}

const ZERO = {
  inputTokens: 1000, outputTokens: 100, reasoningTokens: 10,
  cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1100,
}

describe('deterministic targeted danger recall', () => {
  it('surfaces the omitted late armed pursuit, without inventing a content event', () => {
    const windows = uncoveredRiskWindows(clips(), [], 1)
    expect(windows).toHaveLength(1)
    expect(windows[0]?.cue).toBe('directed_weapon_danger')
    expect(windows[0]?.transcriptText).toContain('Достаём вилы и копья')
    expect(windows[0]?.transcriptText).toContain('загнали меня в тупик')
    expect(windows[0]?.transcriptText).toContain('[7]')
  })

  it('does not recheck a threat already covered by primary safety evidence', () => {
    expect(uncoveredRiskWindows(clips(), [confirmedThreat()])).toHaveLength(0)
  })

  it('does not recheck closing remarks within an already verified armed-pursuit story arc', () => {
    const transcript = normalizeTranscript([
      { text: 'Я не зомби, жители, прекратите.', startMs: 639_000, endMs: 643_000 },
      { text: 'Когда вы не кидаетесь на меня с копьями и вилами.', startMs: 659_000, endMs: 662_279 },
    ])
    const primary = {
      ...confirmedThreat(),
      startMs: 578_720,
      endMs: 612_519,
      evidenceRanges: [{ startMs: 578_720, endMs: 592_399 }, { startMs: 609_279, endMs: 612_519 }],
      sceneStartMs: 554_000,
      sceneEndMs: 662_279,
    }
    expect(uncoveredRiskWindows(transcript, [primary])).toHaveLength(0)
    const closingReport = {
      ...confirmedThreat(),
      subtype: 'physical_attack' as const,
      assertionStatus: 'reported' as const,
      engagementLevel: 'mention' as const,
      startMs: 659_000, endMs: 662_279,
      evidenceRanges: [{ startMs: 659_000, endMs: 662_279 }],
    }
    expect(isDuplicateRiskRecall(closingReport, [primary], 'directed_weapon_danger')).toBe(true)
    expect(isDuplicateRiskRecall({
      ...closingReport, assertionStatus: 'actual',
    }, [primary], 'directed_weapon_danger')).toBe(false)
    // A separate fear/death theme is not enough to certify that an armed
    // threat was assessed at all.
    expect(uncoveredRiskWindows(transcript, [{
      ...primary, category: 'scary_and_disturbing', subtype: 'death_related_theme',
      details: { fearIntensity: 'moderate', threatPresent: false,
        themePresent: true, supernatural: false },
    }])).toHaveLength(1)
  })

  it('recalls the police interrogation despite no explicit weapon name (saved transcript 07:58–08:19)', () => {
    const transcript = normalizeTranscript([
      { text: 'Встал, я сказал: вставай. На кого ты работаешь?', startMs: 475_000, endMs: 479_000 },
      { text: 'Я ни на кого не работаю. А можно, пожалуйста,', startMs: 479_000, endMs: 480_000 },
      { text: 'в меня не целиться?', startMs: 480_000, endMs: 482_000 },
      { text: 'Быстро говори, ты кто такой? Откуда у тебя голова?', startMs: 482_000, endMs: 486_000 },
      { text: 'Нет никакой жертвы, это пластилин.', startMs: 486_000, endMs: 491_000 },
      { text: 'Да хватит в меня целиться.', startMs: 497_000, endMs: 500_000 },
    ])
    const unrelated = {
      ...confirmedThreat(),
      category: 'scary_and_disturbing' as const,
      subtype: 'disturbing_theme' as const,
      startMs: 170_000, endMs: 187_000,
      sceneStartMs: 170_000, sceneEndMs: 213_000,
      evidenceRanges: [{ startMs: 170_000, endMs: 187_000 }],
    }
    const windows = uncoveredRiskWindows(transcript, [unrelated], 1)
    expect(windows).toHaveLength(1)
    expect(windows[0]?.cue).toBe('directed_weapon_danger')
    expect(windows[0]?.transcriptText).toContain('в меня не целиться')
    expect(windows[0]?.transcriptText).toContain('Быстро говори')
  })

  it('does not recheck an already detected police armed threat', () => {
    const transcript = normalizeTranscript([
      { text: 'Вставай, кто ты?', startMs: 477_000, endMs: 480_000 },
      { text: 'Пожалуйста, в меня не целиться. Быстро говори!', startMs: 480_000, endMs: 484_000 },
    ])
    const prior = {
      ...confirmedThreat(), startMs: 480_000, endMs: 484_000,
      sceneStartMs: 475_000, sceneEndMs: 510_000,
      evidenceRanges: [{ startMs: 480_000, endMs: 484_000 }],
    }
    expect(uncoveredRiskWindows(transcript, [prior], 1)).toEqual([])
  })

  it('does not interpret ordinary game aiming or an uncontextualized request as coercion', () => {
    const benign = normalizeTranscript([
      { text: 'Я целюсь в блок из лука, вставай и посмотри.', startMs: 1000, endMs: 5000 },
      { text: 'Пожалуйста, в меня не целиться, мы просто тренируемся.', startMs: 5000, endMs: 9000 },
    ])
    expect(uncoveredRiskWindows(benign, [])).toHaveLength(0)
  })

  it('does not recheck a harmless gameplay sword inventory', () => {
    const transcript = normalizeTranscript([
      { text: 'У меня есть меч, который я хочу испытать.', startMs: 1000, endMs: 4000 },
      { text: 'На тебе испытывать меч не буду. Спасибо.', startMs: 4000, endMs: 7000 },
    ])
    expect(uncoveredRiskWindows(transcript, [])).toEqual([])
  })

  it('recognizes explicit helpless rail danger independently of game context', () => {
    const transcript = normalizeTranscript([
      { text: 'Жителей привязали к рельсам.', startMs: 1000, endMs: 4000 },
      { text: 'Поезд приближается, нужно спасать жителей.', startMs: 4000, endMs: 7000 },
    ])
    expect(uncoveredRiskWindows(transcript, [])[0]?.cue).toBe('helpless_rail_danger')
  })

  it('adds at most a targeted second provider request and reviews its actual output', async () => {
    const calls: boolean[] = []
    const analyzeBatch = vi.fn(async (
      items: OpenAIAnalysisBatchInput[], _categories: ContentCategory[], _diagnostic: boolean,
      targeted = false,
    ): Promise<OpenAIAnalysisBatchResult> => {
      calls.push(targeted)
      return {
        items: items.map(item => ({
          itemId: item.itemId,
          classifiedEvents: targeted ? [confirmedThreat()] : [],
        })),
        usage: ZERO, requestCount: 1,
        provider: { requestId: targeted ? 'risk' : 'base', status: 'completed', latencyMs: 8 },
        requestMetadata: {
          model: 'gpt-test', reasoningEffort: 'low', transcriptLanguage: 'batch',
          enabledCategories: ['violence'], diagnostic: false, promptVersion: 'test', schemaVersion: 'test',
        },
      }
    })
    const provider = {
      model: 'gpt-test', reasoningEffort: 'low', analyzeBatch,
    } as unknown as OpenAIAnalysisProvider
    const analyzer = new BatchedOpenAIAnalyzer(provider, new ProviderScheduler({
      concurrency: 4, maxRetries: 0,
    }), {
      coalesceMs: 1, riskRecallMaxWindows: 2, estimatedPromptTokens: 1,
    })
    const output = await analyzer.analyze(clips(), 'ru', ['violence'], false)
    expect(calls).toEqual([false, true])
    expect(output.classifiedEvents).toHaveLength(1)
    expect(output.requestCount).toBe(2)
    expect(output.riskRecall).toMatchObject({
      cueWindows: 1, rescuedEvents: 1, requestCount: 1, failed: false,
    })
  })

  it('keeps primary events and marks optional recall failure instead of discarding a scan', async () => {
    const analyzeBatch = vi.fn(async (
      items: OpenAIAnalysisBatchInput[], _categories: ContentCategory[], _diagnostic: boolean,
      targeted = false,
    ): Promise<OpenAIAnalysisBatchResult> => {
      if (targeted) throw new Error('temporary provider failure')
      return {
        items: items.map(item => ({ itemId: item.itemId, classifiedEvents: [] })),
        usage: ZERO, requestCount: 1,
        provider: { latencyMs: 5 },
        requestMetadata: {
          model: 'gpt-test', reasoningEffort: 'low', transcriptLanguage: 'batch',
          enabledCategories: ['violence'], diagnostic: false, promptVersion: 'test', schemaVersion: 'test',
        },
      }
    })
    const provider = { model: 'gpt-test', reasoningEffort: 'low', analyzeBatch } as unknown as OpenAIAnalysisProvider
    const analyzer = new BatchedOpenAIAnalyzer(provider, new ProviderScheduler({
      concurrency: 2, maxRetries: 0,
    }), { coalesceMs: 1 })
    const output = await analyzer.analyze(clips(), 'ru', ['violence'], false)
    expect(output.classifiedEvents).toEqual([])
    expect(output.riskRecall).toMatchObject({ failed: true, requestCount: 1 })
    expect(output.requestCount).toBe(2)
  })
})
