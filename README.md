# YT Checker

Проверка речи в последних YouTube-видео канала для родительского контроля. YouTube-данные и captions загружаются только через TranscriptAPI; анализ выполняется официальным OpenAI SDK через Responses API.

## Pipeline

Для каждого видео выполняется один OpenAI request, но классификация больше не равна пользовательскому отчёту:

```text
TranscriptAPI
  → normalizeTranscript
  → OpenAI candidate detection + contextual classification
  → ClassifiedContentEvent
  → deterministic category policy
  → ContentEvent
  → video aggregation
  → channel aggregation
  → presentation
```

Regex/JEV prefilter, отдельные запросы по категориям, второй AI-pass и fallback на другой AI-провайдер не используются. На каждый успешно полученный transcript выполняется ровно один OpenAI request; OpenAI SDK retries отключены. TranscriptAPI повторяет только явно временные HTTP 408/429/5xx, которые по документации не списывают credits; неоднозначные client-side network failures не повторяются.

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
OPENAI_REASONING_EFFORT=low
```

`OPENAI_REASONING_EFFORT` намеренно принимает только `low`. Если ключ OpenAI отсутствует, endpoint возвращает configuration error до загрузки канала и начала анализа.

## OpenAI analyzer

Статический prompt экспортируется как `OPENAI_SYSTEM_PROMPT` из `server/services/openai-analysis.ts` и отправляется отдельным developer message с explicit prompt-cache breakpoint. Динамический transcript идёт отдельным user message. Model input содержит только segment id (`[123] текст`) без timestamps; миллисекунды остаются локально в `transcript.segments`. Tools отключены (`tools: []`), `store: false`.

Structured Output строится через официальный SDK helper `zodTextFormat` и `responses.parse` со strict JSON Schema. Модель описывает фактическую семантику: category/subtype, severity, confidence, context, evidence strength, generic semantic dimensions и category-specific details. Она не получает полей `parentRelevance` или `displayLevel`.

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

После ответа OpenAI сервер проверяет segment indexes и сам детерминированно строит точный `text` и `evidenceRanges[]`: только соседние выбранные segment indexes объединяются в один диапазон. Legacy `startMs/endMs` остаются общей оболочкой для совместимости, но UI использует именно `evidenceRanges[]`. Широкий scene range хранится отдельно. Presentation разрезает ошибочно растянутый `sceneId` по большим промежуткам между фактическими evidence и дополнительно объединяет действительно перекрывающиеся сцены с разными `sceneId`.

## ContentEvent architecture

Подробная схема ответственности, policy registry, analysis profiles, multi-label scenes, legacy migration и regression examples описаны в [docs/content-event-architecture.md](docs/content-event-architecture.md).

Ключевой принцип: `severity`, `confidence`, `parentRelevance` и prevalence — разные показатели. LLM определяет первые фактические свойства события; `parentRelevance` и `displayLevel` рассчитываются backend-кодом детерминированно.

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

Usage хранится в `video.openaiUsage`, включая `cachedTokens` и `cacheWriteTokens`. Reasoning tokens входят в outputTokens; totalTokens не складывается с ними повторно. Стоимость OpenAI не хардкодится. Для GPT-5.6+ используется explicit-only prompt caching: стабильный developer prompt кэшируется, изменяющийся transcript остаётся после breakpoint.

TranscriptAPI credit accounting берётся из официального `X-Credits-Charged` response header; если header отсутствует (например, в mock-тестах), используется документированная стоимость endpoint. Поэтому `creditUsage` в результате должен совпадать с фактическим списанием провайдера.

Unit tests с подставленными ответами проверяют контракт, segment-derived evidence, billing/error handling и нормализацию, но не качество классификации модели. Для оценки false positives/false negatives нужны реальные вызовы выбранной модели на размеченном validation dataset.

## Storage и безопасность

- `none`: ничего не записывает.
- `minimal`: только производный `result.json`; точный transcript/evidence text и diagnostic candidate trace не сохраняются.
- `diagnostic`: дополнительно `transcriptapi-exchanges.json` и `openai-analysis.json` с нормализованным transcript, компактными provider metadata (`requestId`, latency, cache diagnostics/usage), parsed result или безопасной ошибкой. Дубли raw JSON/text, повторяющиеся prompt/schema и encrypted reasoning blobs не сохраняются.

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


## Проверка качества классификатора

`npm run eval:classifier` запускает шесть размеченных случаев из скана 2026-10-04 через реальный OpenAI API: обычное восклицание, самокритика, условная угроза, ошибочное предположение о смерти, строительный демонтаж и прямое оскорбление. Нужен `OPENAI_API_KEY` (или `NUXT_OPENAI_API_KEY`); `.env` загружается локально. Это платные запросы. Обычный `npm test` пропускает эти проверки и работает без сети.

Корпус `evals/content-cases.json` содержит исходные фрагменты и ожидаемые/запрещённые находки. Проверяются обнаружение обязательных событий моделью и итог после серверной политики. Это небольшой регрессионный набор, а не измерение общей точности: для такой оценки нужен отдельный размеченный корпус и полные транскрипты.

Схема 8 добавляет точное `details.expression` для лексики и `details.themePresent` для пугающих тем. Сервер проверяет наличие выражения в evidence, отсеивает нейтральные религиозные восклицания и самокритику. Отрицание фактической смерти не отменяет явно установленную тему похорон. Строительный демонтаж с `actionPurpose=utility` и низкой интенсивностью скрывается в normal-профиле. Проверка индексов также требует, чтобы evidence находились внутри сцены; смысловая полнота объяснения пока обеспечивается инструкцией модели, а не независимым верификатором.
