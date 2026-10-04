import type { TranscriptCandidate } from '../domain/analyze-transcript'
import { getRule } from '../domain/rules'

type JevChoice = 'violation' | 'benign' | 'uncertain'

interface JevChoiceAnswer {
  type?: 'choice'
  choice?: JevChoice
  confidence?: number
  probabilities?: Partial<Record<JevChoice, number>>
}

interface JevResponse {
  answers?: Record<string, JevChoiceAnswer>
}

interface JevQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<JevChoice, string>
}

export interface JevExchange {
  request: {
    url: string
    headers: {
      authorization: 'Bearer <redacted>'
      contentType: 'application/json'
    }
    body: unknown
  }
  response: {
    status: number
    statusText: string
    headers: Record<string, string>
    bodyText: string
    bodyJson: unknown
  }
}

const MAX_CANDIDATES_PER_CALL = 40

export interface ContextFilter {
  filter(candidates: TranscriptCandidate[]): Promise<TranscriptCandidate[]>
}

export class JevContextFilter implements ContextFilter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.typesafe.ai/v1',
    private readonly model = 'jev-latest',
    private readonly benignDropProbability = 0.8,
    private readonly observer?: (exchange: JevExchange) => void | Promise<void>,
  ) {
    if (!apiKey) throw new Error('TypeSafe API key is not configured.')
  }

  async filter(candidates: TranscriptCandidate[]): Promise<TranscriptCandidate[]> {
    const kept: TranscriptCandidate[] = []

    for (let offset = 0; offset < candidates.length; offset += MAX_CANDIDATES_PER_CALL) {
      const chunk = candidates.slice(offset, offset + MAX_CANDIDATES_PER_CALL)
      kept.push(...await this.filterChunk(chunk))
    }

    return kept
  }

  private async filterChunk(candidates: TranscriptCandidate[]): Promise<TranscriptCandidate[]> {
    if (candidates.length === 0) return []

    const state = {
      task: 'Review regex candidates from a parental YouTube content checker. Each candidate contains only a short local transcript window, not the full video transcript.',
      candidates: candidates.map((candidate) => {
        const rule = getRule(candidate.ruleId)
        return {
          id: candidate.id,
          category: candidate.ruleId,
          category_description: rule.description,
          context: candidate.context,
        }
      }),
    }

    const questions = Object.fromEntries(candidates.map((candidate) => {
      const rule = getRule(candidate.ruleId)
      const question: JevQuestion = {
        type: 'choice',
        instructions: `For candidate ${candidate.id}, decide whether the flagged context genuinely matches the parental-content category "${rule.label}". Be conservative about removing candidates: if context is insufficient or ambiguous, choose uncertain rather than benign.`,
        criteria: {
          violation: rule.contextPolicy.violation,
          benign: rule.contextPolicy.benign,
          uncertain: 'The context is insufficient, ambiguous, or could reasonably fit both violation and benign. Do not guess.',
        },
      }
      return [candidate.id, question]
    }))

    const requestBody = {
      state: JSON.stringify(state),
      model: this.model,
      questions,
    }
    const url = `${this.baseUrl.replace(/\/$/, '')}/systemone`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    const bodyText = await response.text()
    let bodyJson: unknown = null
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null
    } catch {
      bodyJson = null
    }

    await this.observer?.({
      request: {
        url,
        headers: {
          authorization: 'Bearer <redacted>',
          contentType: 'application/json',
        },
        body: requestBody,
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        bodyText,
        bodyJson,
      },
    })

    if (!response.ok) throw new Error(`TypeSafe API returned ${response.status}.`)
    const data = bodyJson as JevResponse

    return candidates.filter((candidate) => {
      const answer = data.answers?.[candidate.id]
      if (!answer?.choice || !answer.probabilities) return true
      const benignProbability = answer.probabilities.benign ?? 0
      return !(answer.choice === 'benign' && benignProbability >= this.benignDropProbability)
    })
  }
}
