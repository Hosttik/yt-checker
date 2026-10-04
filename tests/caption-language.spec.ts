import { describe, expect, it } from 'vitest'
import { captionLanguageResolution, captionSource } from '../server/domain/caption-language'

describe('caption language metadata', () => {
  it('derives source only from the actual transcript language', () => {
    expect(captionSource('ru')).toBe('manual')
    expect(captionSource('ru-RU')).toBe('manual')
    expect(captionSource('asr-ru')).toBe('asr')
    expect(captionSource()).toBe('unknown')
  })

  it('treats plain preflight ru resolving to asr-ru as supported same-language ASR resolution', () => {
    expect(captionLanguageResolution('ru', 'asr-ru')).toBe('same_language_asr')
  })

  it('distinguishes exact and harmless regional resolutions', () => {
    expect(captionLanguageResolution('ru', 'ru')).toBe('exact')
    expect(captionLanguageResolution('ru', 'ru-RU')).toBe('same_language_variant')
    expect(captionLanguageResolution('asr-ru', 'asr-ru')).toBe('exact')
    expect(captionLanguageResolution('asr-ru', 'asr-ru-RU')).toBe('same_language_asr')
  })

  it('flags only an actual base-language change as different_language', () => {
    expect(captionLanguageResolution('ru', 'en')).toBe('different_language')
  })

  it('returns unknown when either side is unavailable', () => {
    expect(captionLanguageResolution(undefined, 'ru')).toBe('unknown')
    expect(captionLanguageResolution('ru', undefined)).toBe('unknown')
  })
})
