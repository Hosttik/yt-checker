import type { ClassifiedContentEvent } from '../../shared/types/content'

/**
 * Conservative, offline copy guard. It is intentionally NOT a semantic fact
 * checker: only clear negation reversals and clauses with no lexical anchor in
 * direct evidence trigger a fallback. Uncertain paraphrases remain an eval task.
 */
export type CopyGroundingIssue = 'negation_reversed' | 'unsupported_clause'

const STOP_WORDS = new Set([
  'который', 'которая', 'которые', 'которого', 'которую', 'которым',
  'потому', 'поэтому', 'говорит', 'говорят', 'сказал', 'сказала', 'сообщает',
  'рассказчик', 'персонаж', 'персонажи', 'потом', 'после', 'затем',
  'другого', 'другими', 'вместе', 'сейчас', 'всегда', 'очень', 'просто',
  'снова', 'только', 'также', 'этого', 'этим', 'чтобы', 'когда',
])

function words(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я]{2,}/g) ?? [])
}

function significant(word: string): boolean {
  return word.length >= 5 && !STOP_WORDS.has(word)
}

function root(word: string): string {
  return word.slice(0, 5)
}

function reversesNegation(evidence: string, copy: string): boolean {
  const source = words(evidence)
  const claim = words(copy)
  for (let i = 0; i < source.length - 1; i++) {
    if (source[i] !== 'не' && source[i] !== 'not' && source[i] !== 'never') continue
    const next = source[i + 1]!
    if (!significant(next)) continue
    const matching = claim.findIndex(word => root(word) === root(next))
    if (matching < 0) continue
    const preceding = claim.slice(Math.max(0, matching - 2), matching)
    if (!preceding.some(word => word === 'не' || word === 'not' || word === 'never')) {
      return true
    }
  }
  return false
}

function unsupportedClause(evidence: string, copy: string): boolean {
  const sourceRoots = new Set(words(evidence).filter(significant).map(root))
  const clauses = copy.split(/[,;.!?]+|\s+(?=хотя\b|после\s+чего\b|в\s+конце\b)/iu)
  for (const clause of clauses) {
    const tokens = words(clause).filter(significant)
    // Single novel names/verbs are insufficient: paraphrase and ASR are noisy.
    if (tokens.length < 4) continue
    if (tokens.some(word => sourceRoots.has(root(word)))) continue
    return true
  }
  return false
}

export function copyGroundingIssue(evidence: string, copy: string): CopyGroundingIssue | undefined {
  if (!evidence.trim() || !copy.trim()) return undefined
  if (reversesNegation(evidence, copy)) return 'negation_reversed'
  if (unsupportedClause(evidence, copy)) return 'unsupported_clause'
  return undefined
}

function evidenceQuote(evidence: string): string {
  const compact = evidence.replace(/\s+/g, ' ').trim()
  const limit = 190
  if (compact.length <= limit) return compact
  const cut = compact.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}

/**
 * Never turn unverified surrounding context into a direct-evidence assertion.
 * A diagnostic marker makes the fallback measurable on replay.
 */
export function groundEventCopy<T extends ClassifiedContentEvent>(event: T): T {
  const summary = event.review?.parentSummary
  const summaryIssue = summary ? copyGroundingIssue(event.text, summary) : undefined
  const reasonIssue = copyGroundingIssue(event.text, event.reason)
  if (!summaryIssue && !reasonIssue) return event

  const fallback = `В субтитрах: «${evidenceQuote(event.text)}»`
  return {
    ...event,
    reason: reasonIssue ? fallback : event.reason,
    review: event.review ? {
      ...event.review,
      parentSummary: summaryIssue ? fallback : event.review.parentSummary,
      copyGroundingFallback: summaryIssue ?? reasonIssue,
    } : undefined,
  }
}
