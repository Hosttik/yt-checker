import type { CaptionLanguageResolution, CaptionSource } from '../../shared/types/check'

interface CaptionLanguageParts {
  source: CaptionSource
  base?: string
  normalized?: string
}

function parts(language?: string): CaptionLanguageParts {
  if (!language) return { source: 'unknown' }
  const normalized = language.toLowerCase().replace(/_/g, '-')
  const asr = normalized === 'asr' || normalized.startsWith('asr-')
  const withoutAsr = asr ? normalized.replace(/^asr-?/, '') : normalized
  return {
    source: asr ? 'asr' : 'manual',
    base: withoutAsr.split('-')[0] || undefined,
    normalized,
  }
}

/**
 * Only call this with the language returned by /youtube/transcript.
 * TranscriptAPI support confirmed that a plain code in /youtube/info does not
 * currently prove a human-made track exists.
 */
export function captionSource(language?: string): CaptionSource {
  return parts(language).source
}

export function captionLanguageResolution(
  preflightLanguage?: string,
  resolvedLanguage?: string,
): CaptionLanguageResolution {
  if (!preflightLanguage || !resolvedLanguage) return 'unknown'

  const preflight = parts(preflightLanguage)
  const resolved = parts(resolvedLanguage)

  if (preflight.normalized === resolved.normalized) return 'exact'
  if (preflight.base !== resolved.base) return 'different_language'
  if (resolved.source === 'asr') return 'same_language_asr'
  return 'same_language_variant'
}
