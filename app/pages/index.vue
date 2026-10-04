<script setup lang="ts">
import type {
  ChannelCheckResponse,
  RuleId,
  ScanStorageMode,
  TranscriptUnavailableReason,
} from '../../shared/types/check'

const availableRules: Array<{ id: RuleId; label: string }> = [
  { id: 'profanity_and_rude_language', label: 'Мат и грубая лексика' },
  { id: 'insults', label: 'Оскорбления' },
  { id: 'toilet_humor', label: 'Туалетный юмор' },
  { id: 'gambling', label: 'Азартные игры и ставки' },
  { id: 'sexual_content', label: 'Сексуальные темы' },
  { id: 'violence', label: 'Насилие' },
  { id: 'alcohol_and_drugs', label: 'Алкоголь и наркотики' },
  { id: 'scary_and_disturbing', label: 'Пугающие и тревожные темы' },
  { id: 'tobacco_and_nicotine', label: 'Табак и никотин' },
  { id: 'self_harm', label: 'Самоповреждение' },
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

function violationsFor(video: ChannelCheckResponse['videos'][number], ruleId: RuleId) {
  return video.violations.filter((item) => item.category === ruleId)
}

function unavailableText(reason?: TranscriptUnavailableReason): string {
  if (reason === 'rate_limited') return 'Провайдер временно ограничил запросы.'
  if (reason === 'billing') return 'Закончились credits у TranscriptAPI.'
  if (reason === 'provider_timeout') return 'TranscriptAPI не ответил после повторных попыток.'
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
            <option value="diagnostic">Diagnostic — расширенный debug</option>
          </select>
          <small v-if="storageMode === 'diagnostic'" class="warning">
            Diagnostic сохраняет transcript и компактные provider diagnostics на сервере. Требует разрешения через env.
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
            Transcript HTTP requests: {{ result.selection.transcriptHttpRequests }}.
            Язык: {{ result.selection.requestedLanguage }}.
            Storage: {{ result.storageMode }}.
            <span v-if="result.scanId">Scan ID: {{ result.scanId }}.</span>
          </p>
          <p class="muted">
            OpenAI: {{ result.openaiUsage.requests }} запросов,
            {{ result.openaiUsage.totalTokens }} tokens
            (input {{ result.openaiUsage.inputTokens }}, output {{ result.openaiUsage.outputTokens }},
            reasoning {{ result.openaiUsage.reasoningTokens }},
            cached {{ result.openaiUsage.cachedTokens }},
            cache writes {{ result.openaiUsage.cacheWriteTokens }}).
          </p>
          <p class="muted">
            Речь: {{ result.speechQuality.fillerWordCount }} маркеров /
            {{ result.speechQuality.fillersPer1000Words }} на 1000 слов,
            непосредственных повторов {{ result.speechQuality.repeatedWordCount }} /
            {{ result.speechQuality.repeatedWordsPer1000Words }} на 1000 слов.
          </p>
        </div>
      </div>

      <div class="summary-grid">
        <article v-for="item in result.summary" :key="item.ruleId" class="summary-card">
          <strong>{{ item.violationCount }}</strong>
          <span>{{ item.label }}</span>
          <small>
            {{ item.affectedVideoCount }} видео
            <template v-if="item.severity"> · максимум {{ item.severity }}</template>
          </small>
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
                Transcript track: expected {{ video.expectedCaptionLanguage || 'unknown' }},
                resolved {{ video.transcriptLanguage }} · source {{ video.captionSource || 'unknown' }}.
              </p>
              <p v-if="video.captionSourceMismatch" class="warning">
                TranscriptAPI вернул другой caption track, чем был выбран на preflight.
              </p>
              <p v-if="video.speechQuality" class="muted">
                Речь: {{ video.speechQuality.fillersPer1000Words }} маркеров и
                {{ video.speechQuality.repeatedWordsPer1000Words }} повторов на 1000 слов.
              </p>
              <p v-if="video.status === 'analyzed' && video.detections.length === 0" class="clean">
                По выбранным правилам совпадений не найдено.
              </p>
              <p v-if="video.status === 'provider_error'" class="error">
                OpenAI analysis error: {{ video.analysisError?.type }}.
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
                <small>Всего: {{ detection.count }} · {{ detection.severity }}</small>
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
              <div
                v-for="item in violationsFor(video, detection.ruleId)"
                :key="`${item.startMs}-${item.text}`"
                class="evidence"
              >
                <p>“{{ item.text }}”</p>
                <small>{{ item.reason }} · {{ item.context }} · {{ item.severity }}</small>
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
