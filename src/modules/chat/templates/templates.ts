import { formatGel, pick, type Locale, type Localized } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel } from '../../catalog/catalog.labels.js'
import type { Profile, ProfileKey } from '../profile/profile.model.js'
import type { ReasonCode } from '../tools/search.tool.js'

type QuickMessage = { kind: 'message'; id: string; label: string; text: string }

const t = (ka: string, en: string, ru: string): Localized => ({ ka, en, ru })

export const texts = {
  formIntro: t('რამდენიმე კითხვას დაგისვამთ, რომ თქვენთვის შესაფერისი ბიზნესი შევარჩიო:', 'A few questions so I can find what really fits you:', 'Несколько вопросов, чтобы подобрать то, что вам действительно подходит:'),
  resultsIntro: t('თქვენს კრიტერიუმებთან ყველაზე ახლოს მდგომი ვარიანტებია:', 'Here are the options that best match what you told me:', 'Вот варианты, которые лучше всего подходят под ваши критерии:'),
  cutOff: t('პასუხი ბოლომდე ვერ გაიგზავნა — სცადეთ ხელახლა.', 'The answer was cut off — please try again.', 'Ответ прервался — попробуйте ещё раз.'),
  greeting: t(
    'გამარჯობა! MyBusiness.ge-ის AI ბიზნესკონსულტანტი ვარ. დაგეხმარებით თქვენთვის შესაფერისი ბიზნესის მოძებნასა და განცხადებების შეფასებაში, ასევე გაგაცნობთ შესაძლო რისკებს. რით დავიწყოთ?',
    "Hi! I'm the MyBusiness.ge business consultant. I can help you figure out what kind of business fits you, find matching listings, and explain their strengths and risks. Where shall we start?",
    'Здравствуйте! Я бизнес-консультант MyBusiness.ge. Помогу понять, какой бизнес вам подходит, найду подходящие объявления и объясню их сильные и слабые стороны. С чего начнём?',
  ),
  // Off-topic, with a way back to where the conversation was ({resume} from the profile).
  offTopicResume: t(
    'სამწუხაროდ, ამ საკითხზე ვერ დაგეხმარებით — ეს ჩატი ბიზნესის შერჩევას, შეფასებასა და შეძენას ეხება. გავაგრძელოთ თქვენი ძიება ({resume})?',
    "I'm afraid I can't help with that here — in this chat I only help with choosing, evaluating and buying a business. Shall we continue your search ({resume})?",
    'К сожалению, с этим я здесь не помогу — в этом чате я помогаю только с выбором, оценкой и покупкой бизнеса. Продолжим ваш поиск ({resume})?',
  ),
  offTopic: t(
    'სამწუხაროდ, ამ საკითხზე ვერ დაგეხმარებით — ეს ჩატი ბიზნესის შერჩევას, შეფასებასა და ყიდვა-გაყიდვას ეხება. რით დავიწყოთ?',
    "I'm afraid I can't help with that here — in this chat I only help with choosing, evaluating, buying and selling a business. Where shall we start?",
    'К сожалению, с этим я здесь не помогу — в этом чате я помогаю только с выбором, оценкой, покупкой и продажей бизнеса. С чего начнём?',
  ),
  disclaimer: t(
    '_შენიშვნა: ეს ინფორმაციაა და არა გარანტია ან ფინანსური რჩევა. შეძენამდე გადაამოწმეთ მონაცემები დოკუმენტებით და გაიარეთ კონსულტაცია იურისტთან ან ბუღალტერთან._',
    '_Note: this is information, not a guarantee or financial advice. Verify figures with documents and consult a lawyer/accountant before buying._',
    '_Примечание: это информация, а не гарантия или финансовый совет. Перед покупкой проверьте цифры по документам и проконсультируйтесь с юристом/бухгалтером._',
  ),
}

export function entryQuickReplies(locale: Locale): QuickMessage[] {
  const items: [string, Localized][] = [
    ['buy', t('ბიზნესის შეძენა მინდა', 'I want to buy a business', 'Хочу купить бизнес')],
    ['budget_no_idea', t('ინვესტიციისთვის თანხა მაქვს, მაგრამ ჯერ არ ვიცი, რა შევიძინო', "I have money but don't know what to buy", 'Есть деньги, но не знаю, во что вложить')],
    ['sell', t('ჩემი ბიზნესის გაყიდვა მინდა', 'I want to sell my business', 'Хочу продать свой бизнес')],
    ['how', t('როგორ შევიძინო ბიზნესი საქართველოში?', 'How does buying a business work?', 'Как происходит покупка бизнеса?')],
  ]
  return items.map(([id, label]) => ({ kind: 'message', id: `entry:${id}`, label: pick(label, locale), text: pick(label, locale) }))
}

const reasonLabels: Record<ReasonCode, Localized> = {
  FITS_BUDGET: t('თქვენს ბიუჯეტში ჯდება', 'Fits your budget', 'В рамках бюджета'),
  UNDER_BUDGET: t('ბიუჯეტზე მნიშვნელოვნად ნაკლები ღირს', 'Well under budget', 'Намного дешевле бюджета'),
  NEGOTIATION_NEEDED: t('ფასი თქვენს ბიუჯეტს ოდნავ აღემატება', 'Slightly above budget', 'Чуть выше бюджета'),
  PRICE_ON_REQUEST: t('ფასი შეთანხმებით', 'Price on request', 'Цена по запросу'),
  FITS_HANDS_OFF: t('შესაძლოა, თქვენი ყოველდღიური ჩართულობა არ დასჭირდეს', 'Can run without you', 'Может работать без вас'),
  HAS_MANAGER_OR_TENANT: t('პასიური შემოსავალი', 'Passive income', 'Пассивный доход'),
  NEEDS_OWNER_DAILY: t('მესაკუთრის ყოველდღიურ ჩართულობას საჭიროებს', 'Needs owner daily', 'Нужен владелец ежедневно'),
  MATCHES_EXPERIENCE: t('თქვენს გამოცდილებას შეესაბამება', 'Matches your experience', 'Ваша сфера опыта'),
  IN_PREFERRED_CITY: t('თქვენთვის სასურველ ქალაქშია', 'In your city', 'В вашем городе'),
  MATCHES_SECTOR: t('თქვენთვის სასურველ სფეროშია', 'Your preferred sector', 'Ваша сфера'),
  MATCHES_INTEREST: t('თქვენს ინტერესებს შეესაბამება', 'Matches your interest', 'Совпадает с интересом'),
  FINANCIALS_STATED: t('ფინანსური მონაცემები მითითებულია', 'Financials stated', 'Финансы указаны'),
  NO_FINANCIALS: t('ფინანსური მონაცემები მითითებული არ არის', 'No financials', 'Нет финансов'),
  RED_FLAGS: t('რისკის ნიშნები', 'Red flags', 'Тревожные признаки'),
  BELOW_CATEGORY_MEDIAN: t('საშუალოზე იაფი', 'Below typical price', 'Дешевле обычного'),
  ABOVE_CATEGORY_MEDIAN: t('საშუალოზე ძვირი', 'Above typical price', 'Дороже обычного'),
  PROPERTY_NOT_BUSINESS: t('უძრავი ქონებაა და არა მოქმედი ბიზნესი', 'Property, not a business', 'Недвижимость, не бизнес'),
  PARTNERSHIP_SHARE: t('ბიზნესის წილი ან პარტნიორობა', 'Share / partnership', 'Доля / партнёрство'),
  WILDCARD: t('შესაძლოა, ეს ვარიანტიც დაგაინტერესოთ', 'You might not have considered', 'Вы могли не рассматривать'),
}

export function reasonLabel(code: ReasonCode, locale: Locale): string {
  return pick(reasonLabels[code], locale)
}

const fieldLabels: Partial<Record<ProfileKey, Localized>> = {
  budgetGel: t('ბიუჯეტი', 'Budget', 'Бюджет'),
  goal: t('მიზანი', 'Goal', 'Цель'),
  involvement: t('ბიზნესში ჩართულობა', 'Involvement', 'Участие'),
  experience: t('გამოცდილება', 'Experience', 'Опыт'),
  risk: t('რისკი', 'Risk', 'Риск'),
  capitalShare: t('ინვესტიციის წილი თქვენს დანაზოგში', 'Capital', 'Капитал'),
  cities: t('ქალაქი', 'City', 'Город'),
  sectors: t('სფერო', 'Sector', 'Сфера'),
  assetOpenness: t('ბიზნესი თუ უძრავი ქონება', 'Asset type', 'Тип актива'),
}

const valueLabels: Record<string, Localized> = {
  passive_income: t('პასიური შემოსავალი', 'Passive income', 'Пассивный доход'),
  own_job: t('ბიზნესს თავად ვმართავ', 'Run it myself', 'Управлять самому'),
  growth: t('ზრდა', 'Growth', 'Рост'),
  diversification: t('დივერსიფიკაცია', 'Diversification', 'Диверсификация'),
  unsure: t('ჯერ უცნობია', 'Not sure yet', 'Пока не ясно'),
  hands_off: t('ჩემი ჩართულობის გარეშე', 'Hands-off', 'Без участия'),
  part_time: t('ნახევარ განაკვეთზე', 'Part-time', 'Частично'),
  full_time: t('სრული განაკვეთით', 'Full-time', 'Полностью'),
  none: t('არ მაქვს', 'None', 'Нет'),
  some: t('ცოტა', 'Some', 'Немного'),
  experienced: t('ბიზნესი მქონია', 'Experienced', 'Опытный'),
  low: t('დაბალი', 'Low', 'Низкий'),
  medium: t('საშუალო', 'Medium', 'Средний'),
  high: t('მაღალი', 'High', 'Высокий'),
  all: t('დანაზოგის უმეტესობა', 'Most of savings', 'Большая часть сбережений'),
  part: t('ნაწილი', 'Part of capital', 'Часть капитала'),
  business_only: t('მხოლოდ ბიზნესი', 'Business only', 'Только бизнес'),
  open_to_property: t('ბიზნესი ან ქონება', 'Business or property', 'Бизнес или недвижимость'),
}

export type ProfileItem = { key: ProfileKey; label: string; value: string; inferred: boolean }

// "What I know about you" panel in the UI.
export function profileItems(p: Profile, locale: Locale): ProfileItem[] {
  const items: ProfileItem[] = []
  for (const key of Object.keys(fieldLabels) as ProfileKey[]) {
    const f = p[key]
    if (!f) continue
    let value: string
    if (key === 'budgetGel') value = `≤ ${formatGel(Number(f.value), locale)}`
    else if (key === 'cities') value = p.locationFlexible?.value === true || (f.value as string[]).length === 0 ? pick(t('ნებისმიერი', 'Any', 'Любой'), locale) : (f.value as string[]).map((c) => cityLabel(c, locale)).join(', ')
    else if (key === 'sectors') value = (f.value as string[]).map((c) => categoryLabel(c, locale)).join(', ') || pick(t('ნებისმიერი', 'Any', 'Любая'), locale)
    else value = valueLabels[String(f.value)] ? pick(valueLabels[String(f.value)]!, locale) : String(f.value)
    items.push({ key, label: pick(fieldLabels[key]!, locale), value, inferred: f.status === 'inferred' })
  }
  if (p.locationFlexible?.value === true && !p.cities) {
    items.push({ key: 'locationFlexible', label: pick(fieldLabels.cities!, locale), value: pick(t('ნებისმიერი', 'Any', 'Любой'), locale), inferred: false })
  }
  return items
}
