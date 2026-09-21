<script setup lang="ts">
import type { ChannelCheckResponse, RuleId, TranscriptUnavailableReason } from '../../shared/types/check'

const availableRules: Array<{ id: RuleId; label: string }> = [
  { id: 'profanity', label: 'Мат и грубая лексика' },
  { id: 'insults', label: 'Оскорбления' },
  { id: 'toilet_humor', label: 'Туалетный юмор' },
  { id: 'gambling', label: 'Азартные игры и ставки' },
  { id: 'sexual_content', label: 'Сексуальные темы' },
  { id: 'violence', label: 'Насилие' },
  { id: 'alcohol_drugs', label: 'Алкоголь и наркотики' },
]

const channelUrl = ref('')
const videoLimit = ref(10)
const selectedRuleIds = ref<RuleId[]>(availableRules.map((rule) => rule.id))
const loading = ref(false)
const result = ref<ChannelCheckResponse | null>(null)
const error = ref('')

async function submit() {
  loading.value = true
  error.value = ''
  result.value = null

  try {
    result.value = await $fetch<ChannelCheckResponse>('/api/check', {
      method: 'POST',
      body: {
        channelUrl: channelUrl.value,
        videoLimit: videoLimit.value,
        ruleIds: selectedRuleIds.value,
      },
    })
  } catch (requestError: unknown) {
    const candidate = requestError as {
      data?: { statusMessage?: string; message?: string }
      message?: string
    }

    error.value = candidate.data?.statusMessage
      ?? candidate.data?.message
      ?? candidate.message
      ?? 'Не удалось проверить канал.'
  } finally {
    loading.value = false
  }
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function formatRange(startMs: number, endMs: number): string {
  return `${formatTimestamp(startMs)}–${formatTimestamp(endMs)}`
}

function youtubeTimestampUrl(videoId: string, timestampMs: number): string {
  const seconds = Math.floor(timestampMs / 1000)
  return `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`
}

function unavailableText(reason?: TranscriptUnavailableReason): string {
  if (reason === 'rate_limited') return 'Провайдер временно ограничил запросы.'
  if (reason === 'billing') return 'Закончились credits у transcript-провайдера.'
  if (reason === 'not_available') return 'У ролика нет доступного transcript.'
  return 'Transcript временно недоступен.'
}
</script>

<template>
  <main class="page-shell">
    <section class="hero">
      <p class="eyebrow">YT Checker · MVP</p>
      <h1>Проверь, что ребёнок реально услышит на YouTube-канале</h1>
      <p class="lead">
        Вставь канал. Мы проверим последние ролики по выбранным правилам и покажем только
        категории и диапазоны на таймлайне YouTube — без сохранения и публикации текста transcript.
      </p>
    </section>

    <section class="panel">
      <form class="check-form" @submit.prevent="submit">
        <label class="field">
          <span>YouTube-канал</span>
          <input
            v-model="channelUrl"
            type="text"
            placeholder="https://youtube.com/@channel или @channel"
            required
          >
        </label>

        <label class="field limit-field">
          <span>Последних видео</span>
          <input v-model.number="videoLimit" type="number" min="1" max="15">
        </label>

        <fieldset>
          <legend>Что проверять</legend>
          <div class="rules-grid">
            <label v-for="rule in availableRules" :key="rule.id" class="rule-option">
              <input v-model="selectedRuleIds" type="checkbox" :value="rule.id">
              <span>{{ rule.label }}</span>
            </label>
          </div>
        </fieldset>

        <button :disabled="loading || selectedRuleIds.length === 0">
          {{ loading ? 'Проверяем…' : 'Проверить канал' }}
        </button>
      </form>

      <p v-if="error" class="error">
        {{ error }}
      </p>
    </section>

    <section v-if="result" class="results">
      <div class="channel-card">
        <img
          v-if="result.channel.thumbnailUrl"
          :src="result.channel.thumbnailUrl"
          :alt="result.channel.title"
        >
        <div>
          <p class="eyebrow">Результат проверки</p>
          <h2>{{ result.channel.title }}</h2>
          <p>
            Проанализировано {{ result.analyzedVideos }} из {{ result.requestedVideos }} видео.
            <span v-if="result.failedVideos">Без transcript: {{ result.failedVideos }}.</span>
          </p>
          <p class="muted">
            Контекстный фильтр:
            {{ result.analysisMode === 'regex_jev' ? 'Jev' : 'выключен (regex-only)' }}.
            <span v-if="result.contextualFallbackVideos">
              Fallback на regex: {{ result.contextualFallbackVideos }} видео.
            </span>
          </p>
        </div>
      </div>

      <div class="summary-grid">
        <article v-for="item in result.summary" :key="item.ruleId" class="summary-card">
          <strong>{{ item.hitCount }}</strong>
          <span>{{ item.label }}</span>
          <small>{{ item.videoCount }} видео</small>
        </article>
      </div>

      <div class="videos">
        <article v-for="video in result.videos" :key="video.id" class="video-card">
          <div class="video-heading">
            <div>
              <h3>{{ video.title }}</h3>
              <p v-if="video.status === 'transcript_unavailable'" class="muted">
                {{ unavailableText(video.unavailableReason) }}
              </p>
              <p v-else-if="video.detections.length === 0" class="clean">
                По выбранным правилам совпадений не найдено.
              </p>
              <p v-if="video.contextFilterStatus === 'fallback'" class="muted">
                Jev был недоступен: показаны консервативные regex-кандидаты.
              </p>
            </div>
            <a :href="`https://www.youtube.com/watch?v=${video.id}`" target="_blank" rel="noreferrer">
              Открыть видео
            </a>
          </div>

          <ul v-if="video.detections.length" class="violations">
            <li v-for="detection in video.detections" :key="detection.ruleId">
              <div>
                <strong>{{ detection.label }}</strong>
                <small>Обнаружено: {{ detection.count }}</small>
              </div>

              <div class="range-list">
                <a
                  v-for="range in detection.ranges"
                  :key="`${detection.ruleId}-${range.startMs}-${range.endMs}`"
                  class="timestamp"
                  :href="youtubeTimestampUrl(video.id, range.startMs)"
                  target="_blank"
                  rel="noreferrer"
                >
                  ▶ {{ formatRange(range.startMs, range.endMs) }}
                </a>
              </div>
            </li>
          </ul>
        </article>
      </div>

      <div class="limitations">
        <strong>Что результат пока не означает</strong>
        <ul>
          <li v-for="limitation in result.limitations" :key="limitation">
            {{ limitation }}
          </li>
        </ul>
      </div>
    </section>
  </main>
</template>
