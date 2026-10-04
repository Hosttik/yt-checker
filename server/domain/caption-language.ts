import type { CaptionSource } from '../../shared/types/check'

interface CaptionLanguageParts {
  source: CaptionSource
  base?: string
}

function parts(language?: string): CaptionLanguageParts {
  if (!language) return { source: 'unknown' }
  const normalized = language.toLowerCase().replace(/_/g, '-')
  const asr = normalized === 'asr' || normalized.startsWith('asr-')
  const withoutAsr = asr ? normalized.replace(/^asr-?/, '') : normalized
  return {
    source: asr ? 'asr' : 'manual',
    base: withoutAsr.split('-')[0] || undefined,
  }
}

export function captionSource(language?: string): CaptionSource {
  return parts(language).source
}

export function captionLanguageMismatch(expected?: string, resolved?: string): boolean {
  if (!expected || !resolved) return false
  const expectedParts = parts(expected)
  const resolvedParts = parts(resolved)
  return expectedParts.source !== resolvedParts.source || expectedParts.base !== resolvedParts.base
}
