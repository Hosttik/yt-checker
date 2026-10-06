<script setup lang="ts">
import type {
  ChannelCheckResponse,
  ScanStorageMode,
  TranscriptUnavailableReason,
} from '../../shared/types/check'
import type { AnalysisProfile, ContentCategory, PrevalenceLevel, PresentationScene, ReportLevel } from '../../shared/types/content'

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

function mainScenes(videoId: string) {
  return (videoReport(videoId)?.scenes ?? []).filter((scene) =>
    scene.attention
      ? scene.attention === 'main'
      : scene.level === 'moderate' || scene.level === 'high',
  )
}

function detailScenes(videoId: string) {
  return (videoReport(videoId)?.scenes ?? []).filter((scene) =>
    scene.attention
      ? scene.attention === 'details'
      : scene.level === 'low',
  )
}

function levelText(level: ReportLevel): string {
  if (level === 'high') return 'Высокий'
  if (level === 'moderate') return 'Умеренный'
  if (level === 'low') return 'Низкий'
  return 'Не обнаружено'
}

function sceneLevelText(scene: PresentationScene): string {
  if (scene.evidenceStatus === 'verified') return levelText(scene.level)
  if (scene.evidenceStatus === 'uncertain') {
    return `Требует проверки · ${levelText(scene.level).toLowerCase()} потенциальный приоритет`
  }
  return `Не перепроверено · ${levelText(scene.level).toLowerCase()} потенциальный приоритет`
}

function prevalenceText(level: PrevalenceLevel): string {
  if (level === 'rare') return 'редко'
  if (level === 'occasional') return 'иногда'
  if (level === 'common') return 'часто'
  if (level === 'pervasive') return 'почти во всех видео'
  return 'не обнаружено'
}

function speechMarkerSummary(): string {
  const entries = result.value?.speechQuality.fillerBreakdown.slice(0, 4) ?? []
  return entries.map((entry) => `${entry.marker} — ${entry.count}`).join(', ')
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
            <option value="diagnostic">Diagnostic — сохранять расширенный debug</option>
          </select>
          <small v-if="storageMode === 'diagnostic'" class="warning">
            Diagnostic сохраняет transcript и расширенный trace на сервере, но не меняет классификацию.
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
          <p v-if="result.openaiStages" class="muted">
            Detector: {{ result.openaiStages.detection.requests }} запросов /
            {{ result.openaiStages.detection.totalTokens }} tokens.
            Reviewer: {{ result.openaiStages.review.requests }} запросов /
            {{ result.openaiStages.review.totalTokens }} tokens.
          </p>
          <p class="muted">
            Вывод относится только к {{ result.analyzedVideos }} проанализированным видео и доступным
            субтитрам, а не ко всему каналу.
          </p>
          <div class="limitations">
            <strong>Речевые особенности · отдельно от безопасности</strong>
            <p>{{ result.speechQuality.interpretation.summary }}</p>
            <p v-if="speechMarkerSummary()" class="muted">
              Чаще всего встречаются: {{ speechMarkerSummary() }}.
            </p>
            <small class="muted">{{ result.speechQuality.interpretation.note }}</small>
            <details>
              <summary>Технические метрики</summary>
              <p class="muted">
                Проанализировано {{ result.speechQuality.totalWords }} слов.
                Речевые маркеры: {{ result.speechQuality.fillerWordCount }}
                ({{ result.speechQuality.fillersPer1000Words }} на 1000 слов).
                Повторы слов подряд: {{ result.speechQuality.repeatedWordCount }}
                ({{ result.speechQuality.repeatedWordsPer1000Words }} на 1000 слов).
              </p>
            </details>
          </div>
        </div>
      </div>

      <div class="summary-grid">
        <article v-for="item in result.channelReport" :key="item.category" class="summary-card">
          <strong>Подтверждённый уровень по выборке: {{ levelText(item.level) }}</strong>
          <span>{{ item.label }}</span>
          <small v-if="result.profile === 'diagnostic'">
            shown in {{ item.affectedVideos }}/{{ item.analyzedVideos }} videos ·
            raw affected {{ item.rawAffectedVideos }}/{{ item.analyzedVideos }} ·
            {{ item.displayedEventCount }} shown from {{ item.rawEventCount }} raw signals
          </small>
          <small v-if="item.pendingReviewSceneCount > 0" class="warning">
            Требуют проверки: {{ item.pendingReviewSceneCount }} сцен в
            {{ item.pendingReviewVideos }}/{{ item.analyzedVideos }} видео ·
            потенциальная выраженность: {{ levelText(item.pendingReviewPeakConcern) }}.
          </small>
          <small v-else-if="item.level === 'none'">
            Значимых элементов для выбранного профиля не показано
          </small>
          <small v-else>
            Пиковая выраженность: {{ levelText(item.peakConcern) }} ·
            высокий приоритет: {{ item.highlightedVideos }}/{{ item.analyzedVideos }} видео ·
            заметные эпизоды встречаются {{ prevalenceText(item.moderatePlusPrevalence) }}
            ({{ item.moderatePlusAffectedVideos }}/{{ item.analyzedVideos }} видео) ·
            любые показанные сигналы: {{ item.affectedVideos }}/{{ item.analyzedVideos }} ·
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
                Caption preflight: {{ video.preflightCaptionLanguage || video.expectedCaptionLanguage || 'unknown' }}.
                Получен track: {{ video.transcriptLanguage }} · source {{ video.captionSource || 'unknown' }}.
              </p>
              <p
                v-if="video.captionLanguageResolution === 'same_language_asr'"
                class="muted"
              >
                TranscriptAPI разрешил выбранный язык в auto-generated track. Plain language в /info пока
                не гарантирует human-made captions.
              </p>
              <p v-if="video.captionLanguageResolution === 'different_language'" class="warning">
                TranscriptAPI вернул transcript на другом базовом языке, чем preflight hint.
              </p>
              <p v-if="video.status === 'provider_error'" class="error">
                OpenAI analysis error: {{ video.analysisError?.type }}.
              </p>
              <p
                v-if="video.status === 'analyzed' && (video.contentReview?.status === 'failed' || video.contentReview?.status === 'skipped_after_failure')"
                class="warning"
              >
                Контекстная перепроверка не завершена. Ниже сохранены находки первого прохода —
                их нельзя считать независимо подтверждёнными.
              </p>
              <p
                v-else-if="video.status === 'analyzed' && video.contentReview?.status === 'partial'"
                class="warning"
              >
                Контекстная перепроверка завершена не полностью; спорные находки сохранены консервативно.
              </p>
              <p v-if="video.status === 'analyzed' && videoReport(video.id)?.contentSummary" class="clean">
                {{ videoReport(video.id)?.contentSummary }}
              </p>
            </div>
            <a :href="`https://www.youtube.com/watch?v=${video.id}`" target="_blank" rel="noreferrer">
              Открыть видео
            </a>
          </div>

          <ul v-if="mainScenes(video.id).length" class="violations">
            <li v-for="scene in mainScenes(video.id)" :key="scene.sceneId">
              <div>
                <strong>{{ scene.label }}</strong>
                <small>
                  {{ sceneLevelText(scene) }}
                  <template v-if="result.profile === 'diagnostic'"> · {{ scene.categories.join(', ') }}</template>
                </small>
              </div>
              <div class="range-list">
                <a
                  v-for="range in scene.evidenceRanges"
                  :key="`${scene.sceneId}:${range.startMs}:${range.endMs}`"
                  class="timestamp"
                  :href="youtubeTimestampUrl(video.id, range.startMs)"
                  target="_blank"
                  rel="noreferrer"
                >
                  ▶ {{ formatRange(range.startMs, range.endMs) }}
                </a>
              </div>
              <div class="evidence">
                <p>{{ scene.summary }}</p>
                <small v-if="scene.priorityReason">
                  <strong>Почему высокий приоритет:</strong> {{ scene.priorityReason }}
                </small>
                <small v-if="scene.mitigatingContext">
                  <strong>Контекст:</strong> {{ scene.mitigatingContext }}
                </small>
                <small v-if="result.profile === 'diagnostic'">
                  {{ scene.events.map(event => `${event.subtype} [${event.review?.status || 'not_reviewed'}]`).join(' · ') }}
                </small>
              </div>
            </li>
          </ul>

          <details v-if="detailScenes(video.id).length" class="limitations">
            <summary>Лёгкие и спорные находки ({{ detailScenes(video.id).length }})</summary>
            <ul class="violations">
              <li v-for="scene in detailScenes(video.id)" :key="`detail:${scene.sceneId}`">
                <div>
                  <strong>{{ scene.label }}</strong>
                  <small>{{ sceneLevelText(scene) }}</small>
                </div>
                <div class="range-list">
                  <a
                    v-for="range in scene.evidenceRanges"
                    :key="`detail:${scene.sceneId}:${range.startMs}:${range.endMs}`"
                    class="timestamp"
                    :href="youtubeTimestampUrl(video.id, range.startMs)"
                    target="_blank"
                    rel="noreferrer"
                  >
                    ▶ {{ formatRange(range.startMs, range.endMs) }}
                  </a>
                </div>
                <div class="evidence">
                  <p>{{ scene.summary }}</p>
                  <small v-if="scene.mitigatingContext">
                    <strong>Контекст:</strong> {{ scene.mitigatingContext }}
                  </small>
                </div>
              </li>
            </ul>
          </details>

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
