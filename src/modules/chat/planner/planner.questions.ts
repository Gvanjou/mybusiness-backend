import type { Localized } from '../../../shared/i18n/locale.js'
import type { ProfileKey, Track } from '../profile/profile.model.js'

export type QuestionId =
  | 'budget'
  | 'goal'
  | 'involvement'
  | 'location'
  | 'sector'
  | 'experience'
  | 'risk'
  | 'capital_share'
  | 'asset_openness'
  | 'relax' // not a question: one-tap ways to widen an empty search
  | 'budget_confirm' // not a question: confirm a new budget far from the stated one

export type Option = { id: string; label: Localized; patch: Partial<Record<ProfileKey, unknown>> }

export type Question = {
  id: QuestionId
  fills: ProfileKey[]
  // What the assistant should ask, in plain terms; the responder phrases it naturally.
  intent: string
  // The same question as fixed text, used when the AI is unavailable.
  ask: Localized
  // Teaching note shown with the question, when it helps the user answer.
  teach?: string
  weight: Record<Track, number>
  // Static options; location and sector get options from the live candidate set.
  options?: Option[]
  dynamic?: 'cities' | 'categories'
}

const w = (base: Partial<Record<Track, number>>): Record<Track, number> => ({
  explorer: 0,
  passive_investor: 0,
  owner_operator: 0,
  experienced_expander: 0,
  income_property_seeker: 0,
  specific_searcher: 0,
  seller: 0,
  ...base,
})

export const questions: Question[] = [
  {
    id: 'budget',
    ask: { ka: 'რა თანხის ინვესტირება შეგიძლიათ? მიახლოებითი ოდენობაც საკმარისია.', en: 'How much can you invest in total? A rough range is fine.', ru: 'Какую сумму вы готовы вложить? Достаточно примерного диапазона.' },
    fills: ['budgetGel'],
    intent: 'How much money they can invest in total (a rough range is fine).',
    teach: 'Budget decides which part of the catalogue is realistic, so it comes first.',
    weight: w({ explorer: 1, passive_investor: 1, owner_operator: 1, experienced_expander: 1, income_property_seeker: 1, specific_searcher: 0.9 }),
    options: [
      { id: 'b30', label: { ka: '30 000 ₾-მდე', en: 'Up to 30,000 ₾', ru: 'До 30 000 ₾' }, patch: { budgetGel: 30000 } },
      { id: 'b80', label: { ka: '30 000–80 000 ₾', en: '30–80,000 ₾', ru: '30–80 000 ₾' }, patch: { budgetGel: 80000 } },
      { id: 'b200', label: { ka: '80 000–200 000 ₾', en: '80–200,000 ₾', ru: '80–200 000 ₾' }, patch: { budgetGel: 200000 } },
      { id: 'b500', label: { ka: '200 000 ₾-ზე მეტი', en: 'More than 200,000 ₾', ru: 'Более 200 000 ₾' }, patch: { budgetGel: 600000 } },
    ],
  },
  {
    id: 'goal',
    ask: { ka: 'გსურთ ბიზნესი, რომელიც ყოველდღიური ჩართულობის გარეშეც მოგიტანთ შემოსავალს, თუ თავად აპირებთ მის მართვას?', en: 'Do you want the business to earn without you working in it, or will you run it yourself?', ru: 'Вы хотите, чтобы бизнес приносил доход без вашего участия, или планируете управлять им сами?' },
    fills: ['goal'],
    intent: 'Whether they want income without working in the business, or a business they will run themselves.',
    teach: 'On this market truly hands-off businesses are rare; rental property is the passive alternative.',
    weight: w({ explorer: 0.95, specific_searcher: 0.5 }),
    options: [
      { id: 'passive', label: { ka: 'შემოსავალი ჩემი ყოველდღიური ჩართულობის გარეშე', en: "Income, I won't work in it", ru: 'Доход, сам работать не буду' }, patch: { goal: 'passive_income' } },
      { id: 'own', label: { ka: 'თავად ვიმუშავებ და ვმართავ', en: "I'll run it myself", ru: 'Буду управлять сам' }, patch: { goal: 'own_job' } },
      { id: 'growth', label: { ka: 'განვითარება და მოგვიანებით გაყიდვა', en: 'Grow it and sell later', ru: 'Развить и продать' }, patch: { goal: 'growth' } },
      { id: 'unsure', label: { ka: 'ჯერ არ ვიცი', en: 'Not sure yet', ru: 'Пока не знаю' }, patch: { goal: 'unsure' } },
    ],
  },
  {
    id: 'involvement',
    ask: { ka: 'კვირაში დაახლოებით რამდენი დროის დათმობას შეძლებთ ბიზნესისთვის?', en: 'How much time can you personally give the business?', ru: 'Сколько времени вы готовы уделять бизнесу?' },
    fills: ['involvement'],
    intent: 'How much time they can personally spend in the business.',
    weight: w({ explorer: 0.6, passive_investor: 0.3, owner_operator: 0.3, specific_searcher: 0.7, experienced_expander: 0.3 }),
    options: [
      { id: 'hands_off', label: { ka: 'ყოველდღიურად ვერ ჩავერთვები', en: 'None, fully hands-off', ru: 'Совсем нет времени' }, patch: { involvement: 'hands_off' } },
      { id: 'part_time', label: { ka: 'ნაწილობრივ, კვირაში რამდენიმე საათი', en: 'Part-time', ru: 'Частично' }, patch: { involvement: 'part_time' } },
      { id: 'full_time', label: { ka: 'ყოველდღიურად, სრული დატვირთვით', en: 'Full-time', ru: 'Полный день' }, patch: { involvement: 'full_time' } },
    ],
  },
  {
    id: 'location',
    ask: { ka: 'რომელ ქალაქში ეძებთ ბიზნესს? თუ ქალაქს მნიშვნელობა არ აქვს, ესეც შეგიძლიათ მიუთითოთ.', en: 'Which city do you prefer, or does location not matter?', ru: 'Какой город вы предпочитаете, или место не важно?' },
    fills: ['cities', 'locationFlexible'],
    intent: 'Which city or region they prefer, or whether location does not matter.',
    weight: w({ explorer: 0.5, passive_investor: 0.5, owner_operator: 0.85, experienced_expander: 0.6, income_property_seeker: 0.8, specific_searcher: 0.5 }),
    dynamic: 'cities',
  },
  {
    id: 'sector',
    ask: { ka: 'ბიზნესის რომელი სფეროები გაინტერესებთ? თუ ჯერ არ გადაგიწყვეტიათ, შეგიძლიათ ყველა ვარიანტი განიხილოთ.', en: "What kind of business interests you? If you're not sure yet, you can stay open to anything.", ru: 'Какой тип бизнеса вас интересует? Если пока не знаете, можно рассмотреть все варианты.' },
    fills: ['sectors'],
    intent: 'Which kind of business attracts them, or whether they are open to anything.',
    weight: w({ explorer: 0.55, passive_investor: 0.3, owner_operator: 0.8, experienced_expander: 0.6, specific_searcher: 0.4 }),
    dynamic: 'categories',
  },
  {
    id: 'experience',
    ask: { ka: 'გაქვთ ბიზნესის მართვის ან თქვენთვის საინტერესო სფეროში მუშაობის გამოცდილება?', en: 'Have you run a business or worked in this field before?', ru: 'Есть ли у вас опыт управления бизнесом или работы в этой сфере?' },
    fills: ['experience', 'experienceSectors'],
    intent: 'Whether they have run a business or worked in a specific sector before.',
    teach: 'Experience in the same sector lowers the risk of running it.',
    weight: w({ explorer: 0.3, owner_operator: 0.75, specific_searcher: 0.4 }),
    options: [
      { id: 'none', label: { ka: 'გამოცდილება არ მაქვს', en: 'No experience', ru: 'Нет опыта' }, patch: { experience: 'none' } },
      { id: 'some', label: { ka: 'გარკვეული გამოცდილება მაქვს', en: 'Some experience', ru: 'Немного' }, patch: { experience: 'some' } },
      { id: 'experienced', label: { ka: 'ბიზნესი მქონია', en: "I've run a business", ru: 'Был свой бизнес' }, patch: { experience: 'experienced' } },
    ],
  },
  {
    id: 'capital_share',
    ask: { ka: 'ეს თანხა თქვენი დანაზოგის დიდ ნაწილს შეადგენს თუ მხოლოდ მის ნაწილს?', en: 'Is this money most of your savings, or a part of your capital?', ru: 'Эти деньги — большая часть ваших сбережений или часть капитала?' },
    fills: ['capitalShare'],
    intent: 'Whether this money is all or most of their savings, or a part they can afford to risk.',
    teach: 'If it is most of your savings, I will favour safer, better-documented options.',
    weight: w({ explorer: 0.3, passive_investor: 0.7, owner_operator: 0.3, income_property_seeker: 0.5 }),
    options: [
      { id: 'all', label: { ka: 'ჩემი დანაზოგის უმეტესობაა', en: 'Most of my savings', ru: 'Почти все сбережения' }, patch: { capitalShare: 'all' } },
      { id: 'part', label: { ka: 'დანაზოგის ნაწილია', en: 'A part of my capital', ru: 'Часть капитала' }, patch: { capitalShare: 'part' } },
    ],
  },
  {
    id: 'risk',
    ask: { ka: 'რისკთან დაკავშირებით რომელი მიდგომა გირჩევნიათ: მაქსიმალური სიფრთხილე, დაბალანსებული მიდგომა თუ მეტი რისკისთვის მზად ხართ?', en: 'How do you feel about risk: safety first, balanced, or ready for more risk?', ru: 'Как вы относитесь к риску: безопасность прежде всего, баланс или готовы рисковать?' },
    fills: ['risk'],
    intent: 'How they feel about risk: safety first, balanced, or ready for higher risk for higher return.',
    weight: w({ explorer: 0.3, passive_investor: 0.6, owner_operator: 0.3, experienced_expander: 0.3, income_property_seeker: 0.4 }),
    options: [
      { id: 'low', label: { ka: 'უსაფრთხოება პირველ რიგში', en: 'Safety first', ru: 'Безопасность важнее' }, patch: { risk: 'low' } },
      { id: 'medium', label: { ka: 'დაბალანსებული', en: 'Balanced', ru: 'Сбалансированно' }, patch: { risk: 'medium' } },
      { id: 'high', label: { ka: 'მზად ვარ რისკისთვის', en: 'Ready for more risk', ru: 'Готов к риску' }, patch: { risk: 'high' } },
    ],
  },
  {
    id: 'asset_openness',
    ask: { ka: 'ბიზნესის გარდა, განიხილავთ შემოსავლის მომტან უძრავ ქონებასაც, მაგალითად გასაქირავებელ ფართს?', en: 'Would you also consider income property, such as space to rent out, instead of a business?', ru: 'Рассмотрите ли вы доходную недвижимость, например помещение под аренду, вместо бизнеса?' },
    fills: ['assetOpenness'],
    intent: 'Whether they would also consider income property (commercial space or real estate for rent) instead of an operating business.',
    teach: 'Property is not a business, but it is usually the most passive way to earn income from capital.',
    weight: w({ explorer: 0.3, passive_investor: 0.8 }),
    options: [
      { id: 'business_only', label: { ka: 'მხოლოდ ბიზნესი', en: 'Only a business', ru: 'Только бизнес' }, patch: { assetOpenness: 'business_only' } },
      { id: 'open_to_property', label: { ka: 'ქონებაც განვიხილოთ', en: 'Property is fine too', ru: 'Недвижимость тоже' }, patch: { assetOpenness: 'open_to_property' } },
    ],
  },
]

export const showResultsLabel: Localized = { ka: 'ვარიანტების ნახვა', en: 'Show me options', ru: 'Покажи варианты' }
