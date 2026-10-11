import { describe, expect, it, vi } from 'vitest'
import { normalizeTranscript } from '../server/domain/normalize-transcript'
import { uncoveredRiskWindows } from '../server/domain/detector-risk-recall'
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
