import type { RuleId, RuleSeverity } from '../../shared/types/check'
import { RULE_IDS } from '../../shared/types/check'

export { RULE_IDS }

export interface RuleDefinition {
  id: RuleId
  label: string
  description: string
  severity: RuleSeverity
  patterns: RegExp[]
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
  },
}

export function getRule(ruleId: RuleId): RuleDefinition {
  return RULES[ruleId]
}
