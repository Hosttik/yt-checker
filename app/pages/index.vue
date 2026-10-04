<script setup lang="ts">
import type {
  ChannelCheckResponse,
  RuleId,
  ScanStorageMode,
  TranscriptUnavailableReason,
} from '../../shared/types/check'

const availableRules: Array<{ id: RuleId; label: string }> = [
  { id: 'profanity', label: 'Мат и грубая лексика' },
  { id: 'insults', label: 'Оскорбления' },
  { id: 'toilet_humor', label: 'Туалетный юмор' },
  { id: 'gambling', label: 'Азартные игры и ставки' },
  { id: 'sexual_content', label: 'Сексуальные темы' },
  { id: 'violence', label: 'Насилие' },
  { id: 'alcohol_drugs', label: 'Алкоголь и наркотики' },
]

const runtimeConfig = useRuntimeConfig()
const configuredStorageMode = runtimeConfig.public.defaultStorageMode
const defaultStorageMode: ScanStorageMode = configuredStorageMode === 'none'
  || configuredStorageMode === 'minimal'
  || configuredStorageMode === 'diagnostic'
  ? configuredStorageMode
  : 'minimal'

const configuredTranscriptLanguage = runtimeConfig.public.defaultTranscriptLanguage
const channelUrl = ref('')
const videoLimit = ref(10)
const transcriptLanguage = ref(
  typeof configuredTranscriptLanguage === 'string' ? configuredTranscriptLanguage : '',
)
const storageMode = ref<ScanStorageMode>(defaultStorageMode)
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
        language: transcriptLanguage.value,
        ruleIds: selectedRuleIds.value,
        storageMode: storageMode.value,
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
  if (reason === 'billing') return 'Закончились credits у TranscriptAPI.'
  if (reason === 'not_available') return 'Transcript неожиданно оказался недоступен.'
  return 'Transcript временно недоступен.'
}
</script>

<template>
  <main class="page-shell">
    <section class="hero">
      <p class="eyebrow">YT Checker · MVP</p>
      <h1>Проверь, что ребёнок реально услышит на YouTube-канале</h1>
      <p class="lead">
        Проверяем до 10 последних роликов с доступными субтитрами через TranscriptAPI.com.
        В обычном режиме сохраняем только derived-результат.
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
          <span>Видео для анализа</span>
          <input v-model.number="videoLimit" type="number" min="1" max="10">
        </label>

        <label class="field language-field">
          <span>Язык субтитров</span>
          <input
            v-model.trim="transcriptLanguage"
            list="transcript-language-options"
            type="text"
            placeholder="ru или ru,en,asr"
          >
          <datalist id="transcript-language-options">
            <option value="">Авто</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
            <option value="sk">Slovenčina</option>
            <option value="uk">Українська</option>
            <option value="cs">Čeština</option>
            <option value="de">Deutsch</option>
            <option value="asr">Любые auto-generated captions</option>
          </datalist>
          <small class="muted">
            Можно задать приоритет: ru,en,asr. Пусто = автоматический выбор TranscriptAPI.
          </small>
        </label>

        <label class="field storage-field">
          <span>Режим хранения</span>
          <select v-model="storageMode">
            <option value="none">Не сохранять</option>
            <option value="minimal">Minimal — только результат</option>
            <option value="diagnostic">Diagnostic — полный raw debug</option>
          </select>
          <small v-if="storageMode === 'diagnostic'" class="warning">
            Diagnostic сохраняет raw transcripts и Jev payloads на сервере. Требует разрешения через env.
          </small>
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

      <p v-if="error" class="error">{{ error }}</p>
    </section>

    <section v-if="result" class="results">
      <div class="channel-card">
        <div>
          <p class="eyebrow">Результат проверки</p>
          <h2>{{ result.channel.title }}</h2>
          <p>
            Проанализировано {{ result.analyzedVideos }} из {{ result.requestedVideos }} целевых видео.
          </p>
          <p class="muted">
            TranscriptAPI credits: {{ result.creditUsage.totalCredits }}
            (transcripts {{ result.creditUsage.transcriptCredits }},
            fallback pages {{ result.creditUsage.channelVideosCredits }}).
          </p>
          <p class="muted">
            Проверено кандидатов: {{ result.selection.inspectedVideos }}.
            Caption-eligible: {{ result.selection.captionEligibleVideos }}.
            Язык: {{ result.selection.requestedLanguage }}.
            Storage: {{ result.storageMode }}.
            <span v-if="result.scanId">Scan ID: {{ result.scanId }}.</span>
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
              <p v-if="video.status === 'analyzed' && video.transcriptLanguage" class="muted">
                Transcript track: {{ video.transcriptLanguage }}.
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
        <strong>Как был выполнен scan</strong>
        <ul>
          <li v-for="limitation in result.limitations" :key="limitation">{{ limitation }}</li>
        </ul>
      </div>
    </section>
  </main>
</template>
