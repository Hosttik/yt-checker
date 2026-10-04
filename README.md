# YT Checker

Проверка речи в последних YouTube-видео канала для родительского контроля. YouTube-данные и captions загружаются только через TranscriptAPI; анализ выполняется официальным OpenAI SDK через Responses API.

## Pipeline

Для каждого видео выполняется один простой путь:

```text
TranscriptAPI → normalizeTranscript → один OpenAI Responses API request
              → strict Structured Output → evidence/result.json
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

Structured Output строится через официальный SDK helper `zodTextFormat` и `responses.parse` со strict JSON Schema. Модель не вычисляет timestamps и не возвращает transcript text. Она выбирает только диапазон нормализованных сегментов:

```json
{
  "violations": [{
    "category": "violence",
    "severity": "low",
    "context": "fantasy",
    "type": "not_applicable",
    "startSegment": 120,
    "endSegment": 123,
    "reason": "Фантастические существа атакуют персонажей."
  }]
}
```

Diagnostic mode добавляет только `rejectedCandidates`. В compact/minimal режиме это поле не запрашивается, чтобы не тратить output tokens. Evidence должен быть минимальным: модель использует весь transcript как контекст, но возвращает самый короткий достаточный contiguous segment range.

После ответа OpenAI сервер проверяет segment indexes и сам детерминированно строит `startMs`, `endMs` и точный `text` из нормализованного transcript. Поэтому модель не может ошибиться при переводе `00:08:31.840` в миллисекунды или придумать evidence text.

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

Minimal `result.json` содержит canonical `violations`, компактные `detections`, caption-source metadata, локальные speech-quality метрики и агрегированный OpenAI usage:

```json
{
  "analysisMode": "openai",
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
- `minimal`: только `result.json` с evidence и usage.
- `diagnostic`: дополнительно `transcriptapi-exchanges.json` и `openai-analysis.json` с нормализованным transcript, компактными provider metadata (`requestId`, latency, cache diagnostics/usage), parsed result или безопасной ошибкой. Дубли raw JSON/text, повторяющиеся prompt/schema и encrypted reasoning blobs не сохраняются.

Diagnostic требует `NUXT_ALLOW_DIAGNOSTIC_STORAGE=true`. API-ключ OpenAI никогда не попадает в request metadata, логи или файлы.

## Дополнительные категории и качество речи

Кроме исходных правил поддерживаются `scary_and_disturbing`, `tobacco_and_nicotine` и `self_harm`.

Отдельно от safety-категорий локально и без дополнительного AI-вызова считается `speechQuality`: для русского — частота маркеров «ну», «короче», «типа», «как бы», «значит», «э/ээ», «эм», а для всех языков — непосредственные повторы слов. Это диагностическая метрика, а не оценка «хороший/плохой канал».

Для каждого видео сохраняются `expectedCaptionLanguage` (что выбрал бесплатный `/youtube/info`) и фактический `transcriptLanguage`, а также `captionSource` и `captionSourceMismatch`. Это позволяет видеть случаи, когда провайдер рекламирует manual captions, но возвращает ASR track.

## Проверка

```bash
npm run typecheck
npm test
npm run build
```
