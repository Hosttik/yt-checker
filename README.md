# YT Checker

Проверка речи в последних YouTube-видео канала для родительского контроля. YouTube-данные и captions загружаются только через TranscriptAPI; анализ выполняется официальным OpenAI SDK через Responses API.

## Pipeline

Классификация события и решение «полезно ли это родителю» разделены:

```text
TranscriptAPI
  → normalizeTranscript
  → language-agnostic token chunking + packing
  → batched OpenAI detector: factual candidates across videos/chunks
  → batched OpenAI reviewer on local scene windows only
  → semantic validation
  → deterministic parent policy
  → ContentEvent
  → scene aggregation (main / details)
  → channel aggregation
  → presentation
```

До 10 видео одного scan загружаются параллельно. Анализ не привязан к количеству видео или языку: текст оценивается по UTF-8 размеру, длинные transcript автоматически режутся по segment boundaries с overlap, а короткие chunks из разных видео одного scan упаковываются примерно до заданного token budget. Исходные segment indexes сохраняются, поэтому evidence/timestamps остаются детерминированными.

Все одновременно выполняющиеся scan используют один process-wide OpenAI scheduler. Он ограничивает одновременные provider requests, опционально резервирует RPM/TPM budget и после 429/503 вводит общий cooldown с backoff вместо параллельного retry storm. Один scan дополнительно ограничен небольшим числом одновременно отправленных detector/reviewer batches, поэтому очень длинный канал не занимает все provider slots раньше остальных пользователей.

Detector анализирует несколько видео/chunks одним Structured Output request. Если найдены кандидаты, reviewer объединяет кандидатов из разных видео в batch и получает только локальные transcript windows вокруг этих сцен, а не полный transcript каждого ролика повторно. Дополнительный coverage-pass отключён для обычного production-профиля и запускается только в diagnostic. При transient review failure first-pass findings сохраняются как неперепроверенные, но остальные видео scan продолжают review; глобально review отключается только при authentication failure. TranscriptAPI повторяет только явно временные HTTP 408/429/5xx, которые по документации не списывают credits; неоднозначные client-side network failures не повторяются.

Сканирование канала сначала проверяет бесплатным `/youtube/info`, у каких последних видео есть captions нужного языка. Платные transcript credits имеют жёсткий бюджет, равный `videoLimit`: при лимите 10 приложение не может потратить больше 10 credits на `/youtube/transcript`. Если transcript неожиданно недоступен и не был списан credit, берётся следующий caption-eligible кандидат. Любая ошибка OpenAI после платного transcript останавливает scan, чтобы не расходовать дополнительные TranscriptAPI credits. Платный fallback `/youtube/channel/videos` загружается только когда он нужен и добавляет максимум 1 credit в текущей реализации.

## Настройка

Требуется Node.js 22.12+ и npm 11.21.0. Docker-конфигурация уже фиксирует Node 22.23.3 + npm 11.21.0.

```bash
cp .env.example .env
npm install -g npm@11.21.0
npm ci
npm run dev
```

Обязательные переменные:

```dotenv
NUXT_TRANSCRIPT_API_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-luna
OPENAI_REVIEW_MODEL=gpt-6-luna
OPENAI_REASONING_EFFORT=low

# Performance/concurrency defaults
SCAN_VIDEO_CONCURRENCY=10
OPENAI_GLOBAL_CONCURRENCY=5
TRANSCRIPT_GLOBAL_CONCURRENCY=10
OPENAI_RATE_LIMIT_RETRIES=2
OPENAI_BATCHING_ENABLED=true

# Optional production budgets from the OpenAI project limits
# OPENAI_RPM_BUDGET=
# OPENAI_TPM_BUDGET=

OPENAI_DETECTOR_CHUNK_MAX_ESTIMATED_TOKENS=30000
OPENAI_DETECTOR_BATCH_MAX_ESTIMATED_TOKENS=70000
OPENAI_DETECTOR_BATCH_MAX_ITEMS=5
OPENAI_DETECTOR_CHUNK_OVERLAP_MS=90000
OPENAI_DETECTOR_COALESCE_MS=100
OPENAI_SCAN_BATCH_CONCURRENCY=2

OPENAI_REVIEW_BATCH_MAX_ESTIMATED_TOKENS=70000
OPENAI_REVIEW_BATCH_MAX_ITEMS=4
OPENAI_REVIEW_BATCH_MAX_CANDIDATES=12
OPENAI_REVIEW_COALESCE_MS=100
OPENAI_SCAN_REVIEW_BATCH_CONCURRENCY=2
```

`OPENAI_REASONING_EFFORT` намеренно принимает только `low`. `OPENAI_BATCHING_ENABLED=false` временно возвращает прежний per-video detector/reviewer flow для A/B проверки качества на одинаковых transcript. Если ключ OpenAI отсутствует, endpoint возвращает configuration error до загрузки канала и начала анализа.

`SCAN_VIDEO_CONCURRENCY` ограничивает параллельную загрузку/обработку видео внутри scan. `OPENAI_GLOBAL_CONCURRENCY` — общий лимит provider requests на Node-процесс, а `OPENAI_RPM_BUDGET`/`OPENAI_TPM_BUDGET` позволяют заранее держаться ниже лимитов OpenAI. Detector/reviewer batch limits ограничивают размер одного request. Detector дополнительно ограничен `OPENAI_DETECTOR_BATCH_MAX_ITEMS=5`: обычный scan из 10 коротких видео выполняет два detector batch параллельно, уменьшая critical-path latency относительно одного большого request. `OPENAI_SCAN_*_CONCURRENCY` не даёт одному длинному scan монополизировать process-wide очередь. При горизонтальном масштабировании эти лимиты остаются per-process; для строгого общего quota между несколькими replicas потребуется внешний distributed limiter или отдельный inference gateway.

## OpenAI analyzer

Статический prompt экспортируется как `OPENAI_SYSTEM_PROMPT` из `server/services/openai-analysis.ts` и отправляется отдельным developer message с explicit prompt-cache breakpoint. Динамический transcript идёт отдельным user message. Model input содержит только segment id (`[123] текст`) без timestamps; миллисекунды остаются локально в `transcript.segments`. Tools отключены (`tools: []`), `store: false`.

Первый Structured Output строится через официальный SDK helper `zodTextFormat` и `responses.parse` со strict JSON Schema. Detector описывает фактическую семантику: category/subtype, severity, confidence, context, evidence strength, generic semantic dimensions и category-specific details. Он не получает полей `parentRelevance` или `displayLevel`.

Если есть кандидаты, reviewer получает локальные transcript windows вокруг first-pass гипотез. Review batches ограничиваются не только token budget, но и числом видео/кандидатов; неполный outer-item ответ сохраняет успешные решения и автоматически повторяет только недостающие видео через более узкий fallback. Он возвращает `confirmed/corrected/rejected/uncertain`, заново выбирает прямые evidence-сегменты, отдельно указывает context-сегменты и оценивает родительскую полезность. Для сцены учитываются направление агрессии, намерение/принуждение, последствия, выраженный страх/страдание, длительность, повторяемость и подтверждённое отношение повествования. Reviewer не имеет права выводить визуальные/звуковые факты из отсутствующих данных.

```json
{
  "events": [{
    "candidateId": "candidate_120_1",
    "sceneId": "scene_120",
    "category": "violence",
    "subtype": "fantasy_combat",
    "severity": "low",
    "confidence": 0.97,
    "context": "game",
    "evidenceStrength": "explicit",
    "assertionStatus": "actual",
    "evidenceSegments": [121, 122],
    "sceneStartSegment": 120,
    "sceneEndSegment": 126,
    "details": {
      "harmLevel": "implied",
      "targetType": "fantasy_creature",
      "weaponRole": "used",
      "actionPurpose": "attack"
    },
    "reason": "Герой сражается с зомби в Minecraft."
  }]
}
```

Diagnostic analysis добавляет `rejectedCandidates`. Он включается только профилем `diagnostic`. Режим хранения не меняет запрос к модели: `storageMode=diagnostic` сохраняет расширенный trace, но rejected candidates доступны только для диагностического профиля. Для accepted events модель отдельно возвращает до 6 коротких `evidenceSegments`, которые непосредственно доказывают классификацию, и более широкий `sceneStartSegment`/`sceneEndSegment` для сюжетного контекста.

После каждого ответа OpenAI сервер проверяет segment indexes и сам детерминированно строит точный `text` и `evidenceRanges[]`: только соседние выбранные direct-evidence segment indexes объединяются в один диапазон. Reviewer context сохраняется отдельно в `review.contextRanges` и не используется как доказательство фактических утверждений. Legacy `startMs/endMs` остаются общей оболочкой для совместимости, но UI использует именно `evidenceRanges[]`. Широкий scene range хранится отдельно. Presentation разрезает ошибочно растянутый `sceneId` по большим промежуткам между фактическими evidence и дополнительно объединяет действительно перекрывающиеся сцены с разными `sceneId`.

## ContentEvent architecture

Подробная схема ответственности, policy registry, analysis profiles, multi-label scenes, legacy migration и regression examples описаны в [docs/content-event-architecture.md](docs/content-event-architecture.md).

Ключевой принцип: `severity`, `confidence`, `parentRelevance`, частота и evidence sufficiency — разные показатели. Detector определяет фактические свойства события; reviewer независимо проверяет смысл и рекомендует родительскую значимость; backend policy окончательно рассчитывает `parentRelevance` и `displayLevel`. Неопределённый review не может понизить серьёзную first-pass находку.

## Нормализация

`normalizeTranscript()`:

- сохраняет millisecond timestamps;
- удаляет пустые segments, HTML-обвязку и бессодержательные `[музыка]`;
- склеивает повторяющиеся слова в overlapping caption windows;
- не переводит, не модерирует и не исправляет смысл.

Пример:

```text
[0] Меня и моего друга заточили внутри
[1] красного круга посреди луны.
[2] Лёня дурёня.
```

## Результат и usage

Canonical результат теперь — `contentEvents`, `videoReports` и `channelReport`. Старые `violations`, `detections` и `summary` временно остаются как compatibility projection:

```json
{
  "analysisMode": "openai",
  "profile": "normal",
  "contentEvents": [{
    "category": "violence",
    "subtype": "fantasy_combat",
    "severity": "low",
    "confidence": 0.97,
    "parentRelevance": "moderate",
    "displayLevel": "summary"
  }],
  "openaiUsage": {
    "requests": 1,
    "inputTokens": 1200,
    "outputTokens": 90,
    "reasoningTokens": 32,
    "cachedTokens": 0,
    "cacheWriteTokens": 0,
    "totalTokens": 1322
  },
  "videos": [{
    "id": "video-one11",
    "url": "https://www.youtube.com/watch?v=video-one11",
    "status": "analyzed",
    "violations": [{
      "category": "violence",
      "severity": "low",
      "context": "fantasy",
      "type": "not_applicable",
      "startMs": 511840,
      "endMs": 519000,
      "text": "Лунные зомби атакуют. Бежать нужно.",
      "reason": "Фантастические существа атакуют персонажей; лёгкое игровое насилие."
    }]
  }]
}
```

Usage хранится в `video.openaiUsage`, включая detector+reviewer, а `openaiStages.detection` и `openaiStages.review` позволяют измерять их отдельно. Поля включают `cachedTokens` и `cacheWriteTokens`. Reasoning tokens входят в outputTokens; totalTokens не складывается с ними повторно. Стоимость OpenAI не хардкодится. Для GPT-5.6+ используется explicit-only prompt caching: стабильный developer prompt кэшируется, изменяющийся transcript остаётся после breakpoint.

TranscriptAPI credit accounting берётся из официального `X-Credits-Charged` response header; если header отсутствует (например, в mock-тестах), используется документированная стоимость endpoint. Поэтому `creditUsage` в результате должен совпадать с фактическим списанием провайдера.

Unit tests с подставленными ответами проверяют контракт, segment-derived evidence, billing/error handling и нормализацию, но не качество классификации модели. Для оценки false positives/false negatives нужны реальные вызовы выбранной модели на размеченном validation dataset.

## Storage и безопасность

- `none`: ничего не записывает.
- `minimal`: только производный `result.json`; точный transcript/evidence text и diagnostic candidate trace не сохраняются.
- `diagnostic`: дополнительно `transcriptapi-exchanges.json` и `openai-analysis.json` с нормализованным transcript, first-pass output, review decisions/failures, версиями prompt/schema, validation adjustments/rejections и компактными provider metadata (`requestId`, latency, cache diagnostics/usage). Дубли raw JSON/text, повторяющиеся prompt/schema и encrypted reasoning blobs не сохраняются.

Diagnostic требует `NUXT_ALLOW_DIAGNOSTIC_STORAGE=true`. API-ключ OpenAI никогда не попадает в request metadata, логи или файлы.

## Дополнительные категории и качество речи

Нормализованные content-safety категории: `profanity_and_rude_language`, `insults`, `toilet_humor`, `violence`, `scary_and_disturbing`, `sexual_content`, `gambling`, `substances`, `self_harm`. Старые request ids `alcohol_and_drugs` и `tobacco_and_nicotine` временно принимаются как aliases для `substances`.

Отдельно от safety-категорий локально и без дополнительного AI-вызова считаются речевые особенности: для русского — частота маркеров «ну», «короче», «типа», «как бы», «значит», «э/ээ», «эм», а для всех языков — непосредственные повторы слов. API сохраняет raw counts/rates для диагностики, но UI переводит их в понятное объяснение вроде «примерно 1 раз на 80 слов» и показывает наиболее частые маркеры. Градации «редко / заметно / часто» — продуктовая эвристика, не лингвистическая норма и не оценка «хороший/плохой канал». Для `asr-*` UI отдельно предупреждает, что auto-generated captions могут завышать повторы; когда весь анализ основан на ASR, формулировка прямо говорит «в автоматических субтитрах часто встречаются повторы», а не приписывает их автору как установленную речевую привычку.

Для каждого видео сохраняются `preflightCaptionLanguage` (language hint из бесплатного `/youtube/info`) и фактический `transcriptLanguage`, а также `captionSource` и `captionLanguageResolution`. По подтверждению TranscriptAPI, plain code вроде `ru` в `available_languages` сейчас НЕ гарантирует human-made track; если human track отсутствует, `language=ru` может штатно вернуть `asr-ru`. Поэтому source определяется только по фактическому `language` ответа `/youtube/transcript`.

## Проверка

```bash
npm run typecheck
npm test
npm run build
```


## Проверка качества

Короткий `npm run eval:classifier` остаётся дешёвым регрессионным smoke-test для отдельных semantic edge cases. Он не считается оценкой общей точности.

Основной eval использует сохранённые diagnostic scans и **не вызывает TranscriptAPI**:

```bash
npm run eval:parental-quality
```

По умолчанию читаются:

- `scan-results/2026-10-04T17-30-28-729Z_c382e104-a47f-48cf-b223-75b76b2faf86/`
- `scan-results/2026-10-04T17-59-39-308Z_6b4f06d4-0322-43e3-8eb0-6c0ce24185c8/`

Команда платная только по OpenAI: она повторно анализирует сохранённые **полные** нормализованные transcripts текущим detector, затем тем же входом запускает reviewer и сравнивает saved baseline, current one-pass и current two-pass. Исходные scan-файлы не изменяются; отчёт пишется в `benchmark-results/parental-quality/`.

Разметка `evals/parental-quality-manual.json` — ручной инженерный gold set с `tuning` и `holdout` случаями. `evals/parental-quality-auto-proposals.json` отделён и не участвует в метриках, пока человек не перенесёт подтверждённый кейс в manual set. Метрики включают долю полезных предупреждений среди показанных на размеченной части, пропуски main-сцен, низкоценные карточки, machine-checkable запрещённые интерпретации, полноту первого прохода, requests/tokens/latency. Малый набор не называется доказательством общей точности.

Для повторяемости можно явно сделать два полных прогона:

```bash
npm run eval:parental-quality:stability
```

Ограничения задаются `QUALITY_MAX_VIDEOS` (1–20) и `QUALITY_RUNS` (1–3). Другие сохранённые каталоги передаются через comma-separated `QUALITY_SCAN_DIRS`. Более дорогую reviewer-модель можно проверять через `OPENAI_REVIEW_MODEL`; production default остаётся равным `OPENAI_MODEL`, пока eval не покажет измеримое улучшение.

Обычные `npm test`, `npm run typecheck` и `npm run build` не требуют сети и не запускают платные evals.
