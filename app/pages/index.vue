<script setup lang="ts">
import type {
  ChannelCheckResponse,
  ScanStorageMode,
  TranscriptUnavailableReason,
} from '../../shared/types/check'
import type { AnalysisProfile, ContentCategory, ReportLevel } from '../../shared/types/content'

const availableRules: Array<{ id: ContentCategory; label: string }> = [
  { id: 'profanity_and_rude_language', label: 'Мат и грубая лексика' },
  { id: 'insults', label: 'Оскорбления' },
  { id: 'toilet_humor', label: 'Туалетный юмор' },
  { id: 'violence', label: 'Насилие' },
  { id: 'scary_and_disturbing', label: 'Пугающие и тревожные темы' },
  { id: 'sexual_content', label: 'Сексуальные темы' },
  { id: 'gambling', label: 'Азартные игры и ставки' },
  { id: 'substances', label: 'Алкоголь, никотин и другие вещества' },
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
const profile = ref<AnalysisProfile>('normal')
const selectedRuleIds = ref<ContentCategory[]>(availableRules.map((rule) => rule.id))
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
        profile: profile.value,
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

function videoReport(videoId: string) {
  return result.value?.videoReports.find((item) => item.videoId === videoId)
}

function levelText(level: ReportLevel): string {
  if (level === 'high') return 'Высокий'
  if (level === 'moderate') return 'Умеренный'
  if (level === 'low') return 'Низкий'
  return 'Не обнаружено'
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
        Анализируем речь из доступных субтитров, отделяем найденные content signals
        от того, что действительно стоит показывать родителю.
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
        </label>

        <label class="field">
          <span>Чувствительность отчёта</span>
          <select v-model="profile">
            <option value="normal">Normal — скрывать минимальные сигналы</option>
            <option value="strict">Strict — показывать даже мягкие элементы</option>
            <option value="diagnostic">Diagnostic — показывать всё и trace</option>
          </select>
        </label>

        <label class="field storage-field">
          <span>Режим хранения</span>
          <select v-model="storageMode">
            <option value="none">Не сохранять</option>
            <option value="minimal">Minimal — только результат</option>
            <option value="diagnostic">Diagnostic — расширенный debug</option>
          </select>
          <small v-if="storageMode === 'diagnostic'" class="warning">
            Diagnostic сохраняет transcript и компактные provider diagnostics на сервере.
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
            Профиль: {{ result.profile }}.
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
            Speech quality (отдельная метрика): {{ result.speechQuality.fillerWordCount }} маркеров /
            {{ result.speechQuality.fillersPer1000Words }} на 1000 слов,
            повторов {{ result.speechQuality.repeatedWordCount }} /
            {{ result.speechQuality.repeatedWordsPer1000Words }} на 1000 слов.
          </p>
        </div>
      </div>

      <div class="summary-grid">
        <article v-for="item in result.channelReport" :key="item.category" class="summary-card">
          <strong>{{ levelText(item.level) }}</strong>
          <span>{{ item.label }}</span>
          <small v-if="result.profile === 'diagnostic'">
            shown in {{ item.affectedVideos }}/{{ item.analyzedVideos }} videos ·
            raw affected {{ item.rawAffectedVideos }}/{{ item.analyzedVideos }} ·
            {{ item.displayedEventCount }} shown from {{ item.rawEventCount }} raw signals
          </small>
          <small v-else-if="item.level === 'none'">
            Значимых элементов для выбранного профиля не показано
          </small>
          <small v-else>
            {{ item.affectedVideos }}/{{ item.analyzedVideos }} видео ·
            {{ item.displayedEventCount }} отображаемых событий
          </small>
          <p>{{ item.summary }}</p>
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
              <p v-if="video.status === 'provider_error'" class="error">
                OpenAI analysis error: {{ video.analysisError?.type }}.
              </p>
              <p
                v-if="video.status === 'analyzed' && (videoReport(video.id)?.scenes.length ?? 0) === 0"
                class="clean"
              >
                В текущем профиле значимых особенностей контента не показано.
              </p>
            </div>
            <a :href="`https://www.youtube.com/watch?v=${video.id}`" target="_blank" rel="noreferrer">
              Открыть видео
            </a>
          </div>

          <ul v-if="videoReport(video.id)?.scenes.length" class="violations">
            <li v-for="scene in videoReport(video.id)?.scenes" :key="scene.sceneId">
              <div>
                <strong>{{ scene.label }}</strong>
                <small>
                  {{ levelText(scene.level) }} · {{ scene.categories.join(', ') }}
                </small>
              </div>
              <div class="range-list">
                <a
                  class="timestamp"
                  :href="youtubeTimestampUrl(video.id, scene.startMs)"
                  target="_blank"
                  rel="noreferrer"
                >
                  ▶ {{ formatRange(scene.startMs, scene.endMs) }}
                </a>
              </div>
              <div class="evidence">
                <p>{{ scene.summary }}</p>
                <small v-if="result.profile === 'diagnostic'">
                  {{ scene.events.map(event => event.subtype).join(' · ') }}
                </small>
              </div>
            </li>
          </ul>

          <details v-if="result.profile === 'diagnostic' && videoReport(video.id)" class="limitations">
            <summary>Diagnostic trace</summary>
            <p>
              Candidates: {{ videoReport(video.id)?.candidates?.length ?? 0 }},
              rejected: {{ videoReport(video.id)?.rejectedCandidates?.length ?? 0 }}.
            </p>
            <ul>
              <li
                v-for="candidate in videoReport(video.id)?.rejectedCandidates"
                :key="candidate.candidateId"
              >
                {{ candidate.suspectedCategory }} · {{ formatRange(candidate.startMs, candidate.endMs) }} ·
                {{ candidate.reason }}
              </li>
            </ul>
          </details>
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
