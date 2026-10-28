import { pick, type Locale } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { CatalogSnapshot } from '../../catalog/catalog.service.js'
import { questions, type QuestionId } from '../planner/planner.questions.js'
import { has, type Profile } from '../profile/profile.model.js'
import type { IntakeForm } from './agent.model.js'

// What the reply promised must be on screen. When the model writes "fill in the questions below" but no valid form
// came with it, or "here are the options" without searching, the app delivers it itself — whatever the model did.

// "Fill in the form / questionnaire / these questions" in Georgian, English or Russian.
const PROMISES_FORM = /ფორმ|კითხვარ|ქვემოთ\s+(?:მოცემულ|მოყვანილ)?\s*კითხვ|\bform\b|questionnaire|questions below|анкет|форм[уаы]|вопросы ниже/i
// "Let's look at the options / here are the listings" — a promise of listings, not just any action.
const PROMISES_LISTINGS = /ვარიანტ|განცხადებ|შეთავაზებ|\boptions\b|\blistings\b|businesses for sale|вариант|объявлен|предложени/i

export function promisesForm(text: string): boolean {
  return PROMISES_FORM.test(text.trim().slice(-300))
}

export function promisesListings(text: string): boolean {
  const tail = text.trim().slice(-260)
  return !tail.endsWith('?') && PROMISES_LISTINGS.test(tail)
}

const TITLE = { ka: 'რამდენიმე კითხვა', en: 'A few questions', ru: 'Несколько вопросов' }
const SUBMIT = { ka: 'გაგრძელება', en: 'Continue', ru: 'Продолжить' }
const NOTE = { ka: 'კიდევ რამე, რაც მნიშვნელოვანია? (არასავალდებულო)', en: 'Anything else that matters? (optional)', ru: 'Что-то ещё важное? (необязательно)' }
const ANY = { ka: 'ნებისმიერი', en: 'Any', ru: 'Любой' }

// The questions a buyer is asked first, the form field each one fills, and the profile fact that makes it unnecessary.
const ORDER: { id: QuestionId; field: IntakeForm['questions'][number]['field']; known: (p: Profile) => boolean; value: (patch: Record<string, unknown>) => string }[] = [
  { id: 'budget', field: 'budget', known: (p) => has(p, 'budgetGel'), value: (x) => String(x.budgetGel) },
  { id: 'goal', field: 'goal', known: (p) => has(p, 'goal'), value: (x) => String(x.goal) },
  { id: 'involvement', field: 'involvement', known: (p) => has(p, 'involvement'), value: (x) => String(x.involvement) },
  { id: 'location', field: 'location', known: (p) => has(p, 'cities') || has(p, 'locationFlexible'), value: () => '' },
  { id: 'sector', field: 'sector', known: (p) => has(p, 'sectors'), value: () => '' },
  { id: 'experience', field: 'experience', known: (p) => has(p, 'experience'), value: (x) => String(x.experience) },
  { id: 'risk', field: 'risk', known: (p) => has(p, 'risk'), value: (x) => String(x.risk) },
]

// The most common values on the site right now, for the location and business-type questions.
function topBy(s: CatalogSnapshot, key: 'city' | 'category', n: number): string[] {
  const counts = new Map<string, number>()
  for (const l of s.listings) {
    const v = l[key]
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v)
}

// The intake form for what the profile still lacks, built without a model. null when nothing is missing.
export function defaultIntakeForm(profile: Profile, locale: Locale, s: CatalogSnapshot): IntakeForm | null {
  const out: IntakeForm['questions'] = []
  for (const q of ORDER) {
    if (q.known(profile)) continue
    const def = questions.find((x) => x.id === q.id)
    if (!def) continue
    let options: { value: string; label: string }[]
    if (q.id === 'location') options = [...topBy(s, 'city', 4).map((c) => ({ value: c, label: cityLabel(c, locale) })), { value: 'any', label: pick(ANY, locale) }]
    else if (q.id === 'sector') options = [...topBy(s, 'category', 5).map((c) => ({ value: c, label: categoryLabel(c, locale) })), { value: 'any', label: pick(ANY, locale) }]
    else options = (def.options ?? []).map((o) => ({ value: q.value(o.patch as Record<string, unknown>), label: pick(o.label, locale) }))
    if (options.length < 2) continue
    out.push({ field: q.field, question: pick(def.ask, locale), options: options.slice(0, 6) })
    if (out.length === 5) break
  }
  return out.length ? { title: pick(TITLE, locale), questions: out, noteLabel: pick(NOTE, locale), submitLabel: pick(SUBMIT, locale) } : null
}
