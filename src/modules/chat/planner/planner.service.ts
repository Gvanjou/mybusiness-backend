import { pick, type Locale } from '../../../shared/i18n/locale.js'
import { val, type Profile } from '../profile/profile.model.js'
import { questions, showResultsLabel, type QuestionId } from './planner.questions.js'

// icon marks a next-step chip the app suggests (the UI draws it with that icon); the model's answers have none.
export type QuickReplyIcon = 'compare' | 'location' | 'risk' | 'market' | 'calc' | 'question' | 'search' | 'check' | 'best' | 'more'
export type QuickReply =
  | { kind: 'answer'; id: string; label: string; questionId: QuestionId; optionId: string; icon?: QuickReplyIcon }
  | { kind: 'message'; id: string; label: string; text: string; icon?: QuickReplyIcon }
  | { kind: 'action'; id: string; label: string; action: 'show_results'; icon?: QuickReplyIcon }

// Resolves a tapped option (static or dynamic) to profile values.
export function optionPatch(questionId: QuestionId, optionId: string, profile: Profile = {}): Partial<Record<string, unknown>> | null {
  if (questionId === 'relax') {
    const budget = val(profile, 'budgetGel')
    if (optionId === 'budget_up') return budget ? { budgetGel: Math.round(budget * 1.4) } : null
    if (optionId === 'any_city') return { locationFlexible: true }
    if (optionId === 'any_sector') return { sectors: [] }
    if (optionId === 'include_property') return { assetOpenness: 'open_to_property' }
    return null
  }
  if (questionId === 'location') {
    if (optionId === 'any') return { locationFlexible: true }
    if (optionId.startsWith('city:')) return { cities: [optionId.slice(5)], locationFlexible: false }
    return null
  }
  if (questionId === 'sector') {
    if (optionId === 'any') return { sectors: [] }
    if (optionId.startsWith('cat:')) return { sectors: [optionId.slice(4)] }
    return null
  }
  const q = questions.find((x) => x.id === questionId)
  return q?.options?.find((o) => o.id === optionId)?.patch ?? null
}

export function showResultsReply(locale: Locale): QuickReply {
  return { kind: 'action', id: 'show_results', label: pick(showResultsLabel, locale), action: 'show_results' }
}
