# YT Checker

Проверка речи в последних YouTube-видео канала для родительского контроля. YouTube-данные и captions загружаются только через TranscriptAPI; анализ выполняется официальным OpenAI SDK через Responses API.

## Pipeline

Для каждого видео выполняется один простой путь:

```text
TranscriptAPI → normalizeTranscript → один OpenAI Responses API request
              → strict Structured Output → evidence/result.json
```

Regex/JEV prefilter, отдельные запросы по категориям, второй AI-pass и fallback на другой AI-провайдер не используются. Автоповторы SDK отключены: максимум один HTTP request на transcript, включая временные ошибки.

Сканирование канала сначала проверяет бесплатным `/youtube/info`, у каких последних видео есть captions нужного языка, и анализирует до 10 подходящих видео. Существующая логика TranscriptAPI и платный fallback `/youtube/channel/videos` сохранены.

## Настройка

Требуется Node.js 22+.

```bash
cp .env.example .env
npm install
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

Статический system prompt экспортируется как `OPENAI_SYSTEM_PROMPT` из `server/services/openai-analysis.ts` и отправляется через `instructions` до динамического transcript. Пользовательский input содержит только язык, выбранные категории и компактный transcript с timestamps. Tools отключены (`tools: []`), `store: false`.

Structured Output строится SDK helper `zodTextFormat` со strict JSON Schema. Production schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["violations"],
  "properties": {
    "violations": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["category", "severity", "context", "type", "startMs", "endMs", "text", "reason"],
        "properties": {
          "category": { "enum": ["profanity_and_rude_language", "insults", "toilet_humor", "gambling", "sexual_content", "violence", "alcohol_and_drugs"] },
          "severity": { "enum": ["low", "medium", "high"] },
          "context": { "enum": ["realistic", "game", "fantasy", "cartoon", "verbal", "educational", "idiom", "other"] },
          "type": { "enum": ["profanity", "rude_language", "not_applicable"] },
          "startMs": { "type": "integer", "minimum": 0 },
          "endMs": { "type": "integer", "minimum": 0 },
          "text": { "type": "string" },
          "reason": { "type": "string" }
        }
      }
    }
  }
}
```

Diagnostic mode добавляет только `rejectedCandidates`. В compact/minimal режиме это поле не запрашивается, чтобы не тратить output tokens.

После Structured Output приложение дополнительно проверяет, что evidence text дословно присутствует в нормализованном transcript и timestamps лежат в его диапазоне. Нарушение этой инварианты становится `provider_error`, а видео не помечается безопасным.

## Нормализация

`normalizeTranscript()`:

- сохраняет millisecond timestamps;
- удаляет пустые segments, HTML-обвязку и бессодержательные `[музыка]`;
- склеивает повторяющиеся слова в overlapping caption windows;
- не переводит, не модерирует и не исправляет смысл.

Пример:

```text
[00:00:00.199] Меня и моего друга заточили внутри
[00:00:02.760] красного круга посреди луны.
[00:01:49.960] Лёня дурёня.
```

## Результат и usage

Minimal `result.json` содержит evidence и агрегированный OpenAI usage:

```json
{
  "analysisMode": "openai",
  "openaiUsage": {
    "requests": 1,
    "inputTokens": 1200,
    "outputTokens": 90,
    "reasoningTokens": 32,
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

Usage хранится в `video.openaiUsage`, включая полученный usage отказов, неполных и невалидных ответов. Reasoning tokens входят в outputTokens; totalTokens не складывается с ними повторно. Стоимость не хардкодится.

Unit tests с подставленными ответами проверяют контракт и обработку evidence, но не качество классификации модели. Для оценки false positives нужны реальные вызовы выбранной модели на размеченных примерах.

## Storage и безопасность

- `none`: ничего не записывает.
- `minimal`: только `result.json` с evidence и usage.
- `diagnostic`: дополнительно `transcriptapi-exchanges.json` и `openai-analysis.json` с нормализованным transcript, metadata без ключа, raw structured response, parsed result, usage или безопасной ошибкой.

Diagnostic требует `NUXT_ALLOW_DIAGNOSTIC_STORAGE=true`. API-ключ OpenAI никогда не попадает в request metadata, логи или файлы.

## Проверка

```bash
npm run typecheck
npm test
npm run build
```
