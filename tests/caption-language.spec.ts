import { describe, expect, it } from 'vitest'
import { captionLanguageMismatch, captionSource } from '../server/domain/caption-language'

describe('caption language metadata', () => {
  it('distinguishes manual and ASR tracks', () => {
    expect(captionSource('ru')).toBe('manual')
    expect(captionSource('ru-RU')).toBe('manual')
    expect(captionSource('asr-ru')).toBe('asr')
    expect(captionSource()).toBe('unknown')
  })

  it('flags a manual-to-ASR fallback even for the same base language', () => {
    expect(captionLanguageMismatch('ru', 'asr-ru')).toBe(true)
  })

  it('does not flag harmless regional variants of the same source type', () => {
    expect(captionLanguageMismatch('ru', 'ru-RU')).toBe(false)
    expect(captionLanguageMismatch('asr-ru', 'asr-ru-RU')).toBe(false)
  })

  it('flags a different base language', () => {
    expect(captionLanguageMismatch('ru', 'en')).toBe(true)
  })
})
