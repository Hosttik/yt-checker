import type { ClassifiedContentEvent } from '../../shared/types/content'

/**
 * High precision negation guard. Lexical overlap is NOT an entailment checker
 * and must not replace faithful summaries with long, truncated ASR quotes.
 */
export type CopyGroundingIssue = 'negation_reversed' | 'unsupported_clause'

const TOKEN = /[a-zа-яё]{2,}/giu
const REQUEST_CONTEXT = /(?:пожалуйста|прошу|можно|хватит|перестань|please|could you)/iu

function tokens(text: string): Array<{ word: string; index: number }> {
  return [...text.toLowerCase().replace(/ё/g, 'е').matchAll(TOKEN)].map(match => ({
    word: match[0]!,
    index: match.index!,
  }))
}

function stem(word: string): string {
  return word.slice(0, 5)
}

function reversedNegationRange(
  evidence: string,
  copy: string,
): { start: number; end: number } | undefined {
  const source = tokens(evidence)
  const claim = tokens(copy)
  for (let i = 0; i < source.length - 1; i++) {
    const token = source[i]!
    if (token.word !== 'не' && token.word !== 'not' && token.word !== 'never') continue
    const verb = source[i + 1]!
    if (verb.word.length < 5) continue

    // "Не целиться?" may ask someone to stop aiming and can correctly be
    // described as "the officer aims". This is not a negation reversal.
    const requestSpan = evidence.slice(Math.max(0, token.index - 45), verb.index + verb.word.length + 15)
    if (REQUEST_CONTEXT.test(requestSpan) || /\?/.test(requestSpan)) continue

    const matching = claim.findIndex(item => stem(item.word) === stem(verb.word))
    if (matching < 0) continue
    const hasClaimNegation = claim.slice(Math.max(0, matching - 3), matching)
      .some(item => item.word === 'не' || item.word === 'not' || item.word === 'never')
    if (hasClaimNegation) continue

    // When direct evidence also makes a positive claim using the same verb,
    // its paraphrase may legitimately describe that other claim.
    const sourceHasPositive = source.some((item, at) =>
      at !== i + 1
      && stem(item.word) === stem(verb.word)
      && source.slice(Math.max(0, at - 2), at)
        .every(previous => previous.word !== 'не' && previous.word !== 'not' && previous.word !== 'never'))
    if (sourceHasPositive) continue

    return { start: token.index, end: verb.index + verb.word.length }
  }
  return undefined
}

export function copyGroundingIssue(evidence: string, copy: string): CopyGroundingIssue | undefined {
  if (!evidence.trim() || !copy.trim()) return undefined
  return reversedNegationRange(evidence, copy) ? 'negation_reversed' : undefined
}

function conciseDirectQuote(evidence: string, range: { start: number; end: number }): string {
  const from = Math.max(0, range.start - 48)
  const to = Math.min(evidence.length, range.end + 64)
  const excerpt = evidence.slice(from, to).replace(/\s+/g, ' ').trim()
  return 'В субтитрах: «' + (from > 0 ? '…' : '') + excerpt + (to < evidence.length ? '…' : '') + '»'
}

export function groundEventCopy<T extends ClassifiedContentEvent>(event: T): T {
  const summary = event.review?.parentSummary
  const summaryRange = summary ? reversedNegationRange(event.text, summary) : undefined
  const reasonRange = reversedNegationRange(event.text, event.reason)
  if (!summaryRange && !reasonRange) return event

  return {
    ...event,
    reason: reasonRange ? conciseDirectQuote(event.text, reasonRange) : event.reason,
    review: event.review ? {
      ...event.review,
      parentSummary: summaryRange ? conciseDirectQuote(event.text, summaryRange) : summary,
      copyGroundingFallback: 'negation_reversed',
    } : undefined,
  }
}
