# ContentEvent architecture

## Why this exists

The classifier no longer treats every detected item as a user-facing “violation”.

The content-safety pipeline is:

```text
Transcript
  ↓
LLM candidate detection + contextual classification
  ↓
ClassifiedContentEvent
  ↓
Deterministic category policy
  ↓
ContentEvent
  ↓
Video aggregation
  ↓
Channel aggregation
  ↓
Presentation
```

One OpenAI request is still used per transcript. Candidate discovery and contextual classification are represented inside the same structured response so the architecture does not introduce a second paid AI pass.

## Responsibility boundaries

### LLM

The model describes facts only:

- category / subtype;
- context;
- severity;
- classification confidence;
- evidence strength;
- engagement / portrayal / explicitness;
- category-specific details;
- compact transcript evidence anchors (up to 6 segments);
- broader scene range and candidate / scene ids;
- assertion status (`actual`, `threatened`, `hypothetical`, `negated`, `reported`).

The LLM does **not** decide:

- parent relevance;
- whether an event is hidden;
- whether a card is highlighted;
- channel-level severity;
- UX labels.

### Backend policy

`categoryPolicies` deterministically calculates:

- `parentRelevance`;
- `displayLevel`;
- dynamic category labels / summaries.

Low-confidence or weak-context events keep their factual classification but are prevented from becoming alarming normal-mode highlights.

### Aggregation

Video and channel reports keep these concepts separate:

- content severity;
- model confidence;
- parent relevance;
- prevalence / affected-video ratio.

A single high-relevance event cannot disappear in an average. Conversely, repeated hidden/minimal events do not automatically become a high-level warning.

## Normalized categories

```ts
type ContentCategory =
  | 'profanity_and_rude_language'
  | 'insults'
  | 'toilet_humor'
  | 'violence'
  | 'scary_and_disturbing'
  | 'sexual_content'
  | 'gambling'
  | 'substances'
  | 'self_harm'
```

`speechQuality` is intentionally not a content-safety category.

Legacy request ids remain accepted:

- `alcohol_and_drugs` → internal `substances`;
- `tobacco_and_nicotine` → internal `substances`.

The old aliases retain their old subtype scope when used by an old client.

## Analysis profiles

### normal

Minimal findings are kept internally but hidden from the normal parent report.

### strict

Minimal findings are shown as summary items. Moderate/high findings may be highlighted.

### diagnostic

All accepted findings remain visible and rejected candidates are returned in the diagnostic trace.

Storage mode and analysis profile are separate concepts. `storageMode=diagnostic` only controls persistence; it never changes the classifier request. Rejected-candidate output is requested only by the diagnostic analysis profile.

## Multi-label scenes

Several ContentEvents may describe the same scene.

Example:

```text
scene_55
 ├─ violence / dangerous_situation
 └─ scary_and_disturbing / threatening_character
```

The UI first groups by `sceneId`, splits obviously distant reuse of one id using actual evidence gaps (not the model's broad scene envelope), and then merges substantially overlapping compatible narrative scenes emitted under different ids. Sparse model evidence is materialized as `evidenceRanges[]`: non-adjacent evidence segments remain separate timestamps instead of being expanded to one large interval.

## Old result vs new result

Legacy projection is kept for compatibility:

```json
{
  "videos": [{
    "violations": [{
      "category": "violence",
      "severity": "low",
      "startMs": 80000,
      "endMs": 110000,
      "text": "...",
      "reason": "..."
    }],
    "detections": []
  }],
  "summary": []
}
```

The same scan now also has canonical content events and aggregated reports:

```json
{
  "profile": "normal",
  "contentEvents": [{
    "id": "video:event:0",
    "sourceCandidateId": "video:candidate_80_1",
    "sceneId": "video:scene_80",
    "category": "violence",
    "subtype": "fantasy_combat",
    "severity": "low",
    "confidence": 0.97,
    "context": "game",
    "evidenceStrength": "explicit",
    "evidenceSource": "transcript",
    "engagementLevel": "participation",
    "portrayal": "humorous",
    "explicitness": "mild",
    "startMs": 80000,
    "endMs": 110000,
    "text": "...",
    "reason": "Герой сражается с зомби в Minecraft.",
    "details": {
      "harmLevel": "implied",
      "targetType": "fantasy_creature",
      "weaponRole": "used"
    },
    "parentRelevance": "moderate",
    "displayLevel": "summary"
  }],
  "videoReports": [{
    "videoId": "video",
    "categoryReports": [{
      "category": "violence",
      "label": "Игровое насилие и опасные сцены",
      "level": "moderate",
      "rawEventCount": 1,
      "displayedEventCount": 1,
      "subtypes": ["fantasy_combat"],
      "summary": "..."
    }],
    "scenes": []
  }],
  "channelReport": []
}
```

The legacy fields are derived from `contentEvents`, not independently classified.

## Regression scenarios

The deterministic policy tests cover the current real-world cases:

| Scenario | LLM classification | Parent relevance | Normal display |
|---|---|---|---|
| Character receives a sword | `violence.weapon_presence` | minimal | hidden |
| Police officer practices shooting at a target | `violence.weapon_use`, harm none, purpose sport | low | summary |
| Harmless demonstration of a gifted weapon | `violence.weapon_use`, harm none, purpose demonstration | minimal | hidden |
| Minor accidental injury | `violence.injury`, purpose accident, low severity | minimal | hidden |
| Fantasy zombie combat | `violence.fantasy_combat` | moderate | summary |
| Zombies force their way into a bunker | violence + scary, shared sceneId | moderate+ | one scene card |
| Pitchfork threat against a character | `violence.violent_threat` | high | highlight |
| Characters tied to railway tracks before an approaching train | `violence.life_threatening_situation` | high | highlight |
| Neutral cigarette mention | `substances.nicotine`, mention | minimal | hidden |
| Adult character smokes | `substances.nicotine`, use | low | summary |
| Glamorized smoking promotion | `substances.nicotine`, promotion | high | highlight |
| Accidental fall | not self-harm | rejected candidate / no event | hidden |
| “Я сейчас умру” without self-directed intent | not self-harm | rejected candidate / no event | hidden |

## Transcript-only limits

The classifier must not make claims that require video frames or audio that it did not analyze.

For example, the system may state:

> In the analyzed transcript, no graphic descriptions of violence were detected.

It must not claim:

> There is no graphic violence in the video.

Visual jump scares, visible blood, nudity, injuries and similar visual facts require a future visual pipeline.

## Diagnostic trace

Diagnostic data preserves enough information to follow:

```text
candidate
→ contextual classification
→ normalized ContentEvent
→ parentRelevance
→ displayLevel
→ video aggregation
→ channel aggregation
```

Relevant structured log events:

- `content.candidate`
- `content.classified`
- `content.rejected`
- `content.relevance`
- `content.display`
- `content.aggregate`

## Speech quality

Speech quality remains a separate analysis dimension and is not mixed into ContentEvent taxonomy or safety aggregation.

Raw counts/rates are retained for diagnostics, while the parent-facing report explains them as approximate frequencies (for example, «примерно 1 раз на 80 слов») and shows common markers. Frequency bands are product heuristics, not normative language-quality thresholds. Auto-generated captions are explicitly marked because ASR duplication can inflate repetition counts. When all analyzed captions are ASR, the human-facing wording attributes repetitions to the automatic subtitles rather than asserting that they definitely reflect the creator's speech.

The transcript heuristic can evolve independently toward a dedicated audio-based pipeline.
