# Content Policy v2: child-safety semantics

Date: 2026-10-08

## Problem

The current architecture already separates event detection, review, deterministic policy and presentation, but several child-safety criteria used by established rating/risk frameworks are still implicit or missing from `ContentEvent`:

- realistic vs fantasy/stylized presentation;
- ease of imitation;
- whether harmful behaviour is rewarded, shown without consequences, or followed by negative consequences;
- endorsement as distinct from mere depiction and from a direct call to act;
- child-age sensitivity, although `ParentPolicyPreferences.childAge` already exists;
- reviewer `recommendedParentRelevance` can still influence the final relevance decision, so the LLM partly owns a product-policy decision.

This makes two semantically different scenes look too similar to deterministic policy. It also makes policy harder to calibrate without prompt-only changes.

## Regression cases

The implementation must preserve these distinctions:

1. Brief fantasy/game violence is not escalated only because violence was detected.
2. Realistic, easy-to-copy harmful behaviour is more relevant for younger children than stylized/fantasy behaviour.
3. A depiction is weaker than endorsement, encouragement or instruction.
4. Harmful behaviour shown as rewarded/glamorized can be more relevant than the same behaviour clearly discouraged with negative consequences.
5. Educational context is not an automatic safety downgrade; explicit harmful instructions remain significant.
6. Reviewer factual corrections may change the normalized event, but reviewer opinion about parent relevance must not override deterministic policy.
7. Existing events without the new semantic dimensions remain valid and keep legacy policy behavior.

## Design

Keep the existing taxonomy and pipeline. Add cross-category semantic dimensions instead of creating more top-level categories in this change:

- `realism: fantasy | stylized | realistic | unknown`
- `imitationRisk: none | low | medium | high`
- `behaviorOutcome: negative_consequences | neutral | no_consequences | rewarded | unknown`
- extend `engagementLevel` with `endorsement`

The detector/reviewer describes these facts. The backend policy derives parent relevance.

Existing UI mapping stays compatible:

- `hidden` = suppress
- `summary` = details
- `highlight` = show/main attention candidate

No synthetic global safety score is introduced.

## Deterministic policy rules

Cross-category floors are intentionally conservative:

- self-harm, substances and gambling: endorsement/encouragement/instruction cannot be treated like a neutral mention;
- violence: high imitation risk plus endorsement/encouragement/instruction/rewarded framing raises concern; realistic + high imitation risk has at least moderate relevance;
- younger-child adjustment only reacts to concrete salience modifiers (realism, imitation risk, rewarded/glamorized framing), not to category presence alone;
- educational/discouraging context never cancels explicit instruction solely because the context is educational.

Reviewer `recommendedParentRelevance` remains stored for diagnostics/backward compatibility in this change, but final relevance is derived from normalized event semantics and deterministic review facts.

## Measurement

Required before merge:

- `npm run typecheck`
- `npm test`
- `npm run build`
- new unit regressions for the cases above
- schema/prompt tests verifying the new dimensions are requested and UX decisions remain absent from detector output

Paid model evals are useful calibration evidence but are not a substitute for deterministic regressions and are not required for this structural change.

## Risks

- More structured fields increase model output size slightly.
- New semantic fields may initially be noisy; therefore they only introduce conservative relevance floors and age adjustments.
- Old saved events do not contain the new fields, so fields are optional in TypeScript and policy falls back to legacy behavior.
- This change does not add a positive/educational-value scorer. Positive/usefulness assessment should remain a separate axis and requires its own evaluation set rather than being inferred as the inverse of safety.


## Deliberate scope gaps

This version does not claim full coverage of every external child-safety taxonomy. In particular, dedicated eating-disorder, bullying/hate, dangerous-challenge and commercial-pressure categories require independent examples, human labels and reporting rules before being promoted to first-class categories. Existing categories may capture parts of those concepts, but that is not equivalent to dedicated coverage.

Positive value/usefulness (educational value, prosocial behavior, positive role models, creativity, critical thinking) must be implemented as a separate assessment axis with its own evaluation set. Absence of positive value is not a safety concern, and positive value must not cancel a safety concern.

## Methodology references

The semantic dimensions are informed by public guidance rather than copied as a numerical rating formula:

- BBFC classification guidance: context, realism/style, detail, frequency and imitable behavior matter when judging violence and dangerous behavior.
  https://www.bbfc.co.uk/parents-guide-age-ratings/bbfc-guide-violence
- BBFC age-rating guidance: context/frequency matter for language; drug misuse should not be glamorized or instructional; dangerous behavior should not dwell on easily copied detail.
  https://www.bbfc.co.uk/rating/12
  https://www.bbfc.co.uk/rating/u
- Ofcom child-safety guidance distinguishes depiction from content that encourages, promotes or provides instructions for harmful behavior.
  https://www.ofcom.org.uk/online-safety/protecting-children/protection-of-children-duties-under-the-online-safety-act
- Common Sense Media developmental guidance highlights imitation, whether aggression is rewarded, the attractiveness of the aggressor and consequences, especially for younger children.
  https://www.commonsensemedia.org/about-us/our-mission/about-our-ratings/8-9

These sources do not define one universal mathematical score. The deterministic policy in this repository is a product policy derived from these recurring factors and must be calibrated against our own labeled data.
