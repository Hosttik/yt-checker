import type { ContentEvent } from '../../shared/types/content'

const labels: Record<string, string> = {
  'profanity_and_rude_language.profanity': 'нецензурная лексика',
  'profanity_and_rude_language.rude_language': 'грубая речь',
  'profanity_and_rude_language.slur': 'уничижительная лексика',
  'profanity_and_rude_language.obscene_expression': 'непристойные выражения',

  'insults.direct_insult': 'прямые оскорбления',
  'insults.mockery': 'насмешки',
  'insults.humiliating_name': 'унизительные прозвища',
  'insults.degrading_statement': 'унижающие высказывания',

  'toilet_humor.toilet_reference': 'туалетные упоминания',
  'toilet_humor.toilet_joke': 'туалетные шутки',
  'toilet_humor.bodily_function': 'шутки о физиологии',
  'toilet_humor.gross_out_humor': 'нарочито неприятный физиологический юмор',

  'violence.weapon_presence': 'оружие без применения',
  'violence.weapon_use': 'использование оружия',
  'violence.violent_threat': 'угрозы физического вреда',
  'violence.physical_attack': 'физические нападения',
  'violence.fantasy_combat': 'игровые или фантастические сражения',
  'violence.dangerous_situation': 'опасные ситуации',
  'violence.life_threatening_situation': 'угрожающие жизни ситуации',
  'violence.destruction': 'разрушения',
  'violence.injury': 'травмы',
  'violence.death': 'смерть',
  'violence.graphic_violence': 'графические описания насилия',

  'scary_and_disturbing.threatening_character': 'угрожающий персонаж',
  'scary_and_disturbing.pursuit': 'преследование',
  'scary_and_disturbing.horror_theme': 'хоррор-тематика',
  'scary_and_disturbing.jump_scare': 'внезапный пугающий эпизод',
  'scary_and_disturbing.disturbing_theme': 'тревожная тема',
  'scary_and_disturbing.death_related_theme': 'темы смерти и похорон',
  'scary_and_disturbing.confinement': 'запирание или изоляция',
  'scary_and_disturbing.intense_peril': 'сильное ощущение опасности',
  'scary_and_disturbing.other': 'другой пугающий контент',

  'sexual_content.romantic_reference': 'романтические упоминания',
  'sexual_content.suggestive_reference': 'двусмысленные намёки',
  'sexual_content.sexual_joke': 'сексуальные шутки',
  'sexual_content.sexual_discussion': 'обсуждение сексуальных тем',
  'sexual_content.sexual_behavior': 'сексуальное поведение',
  'sexual_content.explicit_sexual_content': 'явный сексуальный контент',

  'gambling.mention': 'упоминания азартных игр',
  'gambling.simulated_gambling': 'имитация азартных игр',
  'gambling.real_money_gambling': 'азартные игры на реальные деньги',
  'gambling.betting': 'ставки',
  'gambling.promotion': 'продвижение азартных игр',
  'gambling.instruction': 'инструкции по азартным играм',

  'substances.alcohol': 'алкоголь',
  'substances.nicotine': 'табак и никотин',
  'substances.drugs': 'наркотические вещества',
  'substances.medication_misuse': 'неправильное употребление лекарств',
  'substances.other': 'другие вещества',

  'self_harm.self_injury_reference': 'упоминания самоповреждения',
  'self_harm.self_injury_act': 'самоповреждение',
  'self_harm.suicidal_ideation': 'суицидальные мысли',
  'self_harm.suicide_threat': 'угроза суицида',
  'self_harm.suicide_attempt': 'попытка суицида',
  'self_harm.suicide_death': 'суицидальная смерть',
  'self_harm.encouragement': 'поощрение самоповреждения',
  'self_harm.instruction': 'инструкции по самоповреждению',
  'self_harm.joke_or_casual_reference': 'небрежная или шуточная отсылка',
}

export function contentSubtypeLabel(
  event: Pick<ContentEvent, 'category' | 'subtype'>,
): string {
  return labels[`${event.category}.${event.subtype}`] ?? event.subtype
}
