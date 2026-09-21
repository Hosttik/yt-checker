import type { RuleId, RuleSeverity } from '../../shared/types/check'
import { RULE_IDS } from '../../shared/types/check'

export { RULE_IDS }

export interface RuleDefinition {
  id: RuleId
  label: string
  description: string
  severity: RuleSeverity
  patterns: RegExp[]
  contextPolicy: {
    violation: string
    benign: string
  }
}

function words(source: string): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])(${source})(?=$|[^\\p{L}])`, 'giu')
}

export const RULES: Record<RuleId, RuleDefinition> = {
  profanity: {
    id: 'profanity',
    label: 'Мат и грубая лексика',
    description: 'Явная ненормативная и грубая лексика.',
    severity: 'high',
    patterns: [
      words('бл(?:я+|ять|ядь)|сука|суч(?:ка|ара)|ху(?:й|я|е|и|ев|ево)|пизд[а-яё]*|еб(?:ать|ан[а-яё]*|уч[а-яё]*)|ёб[а-яё]*'),
      words('fuck(?:ing|ed)?|shit|bitch(?:es)?|asshole'),
    ],
    contextPolicy: {
      violation: 'The flagged expression is actually spoken as profanity or coarse language. Quoted or repeated profanity still counts because a child hears the word.',
      benign: 'The regex matched by accident, such as a substring, name, transcription artifact, or a word that is not actually profanity in this context.',
    },
  },
  insults: {
    id: 'insults',
    label: 'Оскорбления',
    description: 'Прямые унизительные обращения и команды.',
    severity: 'medium',
    patterns: [
      words('дебил(?:ка|ы)?|идиот(?:ка|ы)?|туп(?:ой|ая|ые)|придурок|кретин|лох|заткнись'),
      words('idiot|moron|stupid|loser|shut\\s+up'),
    ],
    contextPolicy: {
      violation: 'A person or character is being directly demeaned, mocked, called a derogatory name, or aggressively told to be quiet.',
      benign: 'The term is discussed abstractly, explained as a word, negated, or otherwise not used to insult or demean someone.',
    },
  },
  toilet_humor: {
    id: 'toilet_humor',
    label: 'Туалетный юмор',
    description: 'Лексика про испражнения и физиологический юмор.',
    severity: 'low',
    patterns: [
      words('какашк[а-яё]*|говн[а-яё]*|жоп[а-яё]*|перд[а-яё]*|пук(?:ать|нул|нула|нули)?'),
      words('poop|poopy|fart(?:ed|ing)?|butt'),
    ],
    contextPolicy: {
      violation: 'Bodily functions, excrement, farting, buttocks, or similar material are used as a joke, insult, recurring focus, or deliberately crude entertainment.',
      benign: 'The mention is neutral, medical, educational, incidental, or a regex/transcription false match rather than toilet humor.',
    },
  },
  gambling: {
    id: 'gambling',
    label: 'Азартные игры и ставки',
    description: 'Казино, букмекерские ставки и слот-механики.',
    severity: 'high',
    patterns: [
      words('казино|букмекер[а-яё]*|ставк(?:а|и|у|ах)|слот(?:ы|ах)?|рулетк[а-яё]*'),
      words('casino|betting|sportsbook|slot\\s+machine'),
    ],
    contextPolicy: {
      violation: 'The context involves real-money gambling, betting, casino play, gambling promotion, gambling mechanics presented as desirable, or encouragement to gamble.',
      benign: 'The term refers only to a harmless game mechanic, metaphor, fictional setting without gambling behavior, neutral warning, or unrelated meaning.',
    },
  },
  sexual_content: {
    id: 'sexual_content',
    label: 'Сексуальные темы',
    description: 'Явные сексуальные и порнографические упоминания.',
    severity: 'high',
    patterns: [
      words('секс(?:а|ом|у)?|порно[а-яё]*|эротик[а-яё]*|гол(?:ый|ая|ые)|обнажен[а-яё]*'),
      words('sex(?:ual)?|porn(?:ography)?|nude|naked'),
    ],
    contextPolicy: {
      violation: 'The context is sexualized, explicitly sexual, pornographic, erotic, or focuses on nudity in a sexual or inappropriate way for children.',
      benign: 'The mention is neutral education, biology, safety, non-sexual nudity reference, or a lexical/transcription false match.',
    },
  },
  violence: {
    id: 'violence',
    label: 'Насилие',
    description: 'Явные упоминания убийства, крови, оружия и стрельбы.',
    severity: 'medium',
    patterns: [
      words('уб(?:ью|ить|ил|ила|или)|кровь|зареж[а-яё]*|оружие|пистолет|стрел(?:ять|ял|яла)'),
      words('kill(?:ed|ing)?|blood|gun|shoot(?:ing|er)?'),
    ],
    contextPolicy: {
      violation: 'The context depicts, threatens, celebrates, describes, or encourages realistic or disturbing physical violence, injury, killing, weapons, or blood.',
      benign: 'The reference is clearly non-graphic cartoon/gameplay mechanics, figurative speech, historical/educational context without disturbing detail, or a lexical false match.',
    },
  },
  alcohol_drugs: {
    id: 'alcohol_drugs',
    label: 'Алкоголь и наркотики',
    description: 'Упоминания алкоголя и наркотических веществ.',
    severity: 'medium',
    patterns: [
      words('алкогол[а-яё]*|водк[а-яё]*|пив(?:о|а)|вино|наркотик[а-яё]*|кокаин|марихуан[а-яё]*'),
      words('alcohol|vodka|beer|wine|drugs?|cocaine|weed'),
    ],
    contextPolicy: {
      violation: 'The context features consumption, intoxication, recreational drug use, promotion, normalization, jokes centered on alcohol/drugs, or instructions related to their use.',
      benign: 'The mention is neutral education, health/safety warning, incidental non-consumption context, or a lexical false match.',
    },
  },
}

export function getRule(ruleId: RuleId): RuleDefinition {
  return RULES[ruleId]
}
