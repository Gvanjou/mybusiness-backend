import type { Localized } from '../../../shared/i18n/locale.js'

// Next-step chips the app offers under an answer. label = button text; text = the message sent when tapped,
// written so the model calls the right tool. {ref} = "#2 საკონდიტრო, ვაკე", {city} and {sector} = names. Chips about
// one listing get its number and name in front of the label ("#2 საკონდიტრო — მოგება").
export type NextKey = 'compare' | 'location' | 'risks' | 'price' | 'calc' | 'seller' | 'visit' | 'similar' | 'market' | 'best' | 'risks_each' | 'locations' | 'show' | 'district' | 'check' | 'market_sector' | 'listings_sector' | 'more'

const t = (ka: string, en: string, ru: string): Localized => ({ ka, en, ru })

export const NEXT: Record<NextKey, { label: Localized; text: Localized }> = {
  compare: { label: t('შეადარე ეს ვარიანტები', 'Compare these options', 'Сравнить варианты'), text: t('შეადარე ნაჩვენები ვარიანტები ერთმანეთს', 'Compare the options shown side by side', 'Сравни показанные варианты между собой') },
  location: { label: t('ლოკაცია', 'Location', 'Локация'), text: t('გააანალიზე ლოკაცია და კონკურენცია: {ref}', 'Analyse the location and competition of {ref}', 'Проанализируй локацию и конкуренцию: {ref}') },
  risks: { label: t('რისკები', 'Risks', 'Риски'), text: t('რა რისკებია: {ref}?', 'What are the risks of {ref}?', 'Какие риски у {ref}?') },
  price: { label: t('ფასი მსგავსებთან', 'Price vs similar', 'Цена к похожим'), text: t('შეაფასე ფასი მსგავს განცხადებებთან შედარებით: {ref}', 'Is the price of {ref} fair against similar listings?', 'Оцени цену {ref} по сравнению с похожими'), },
  calc: { label: t('მოგება', 'Profit', 'Прибыль'), text: t('გამოთვალე მოგების სცენარები: {ref}', 'Work out the profit scenarios for {ref}', 'Рассчитай сценарии прибыли: {ref}') },
  seller: { label: t('კითხვები გამყიდველს', 'Ask the seller', 'Вопросы продавцу'), text: t('მოამზადე შეტყობინება გამყიდველისთვის: {ref}', 'Prepare a message to the seller of {ref}', 'Подготовь сообщение продавцу: {ref}') },
  visit: { label: t('რა შევამოწმო ადგილზე', 'What to check on site', 'Что проверить на месте'), text: t('რა შევამოწმო ადგილზე: {ref}?', 'What should I check on site at {ref}?', 'Что проверить на месте: {ref}?') },
  similar: { label: t('მსგავსი ვარიანტები', 'Similar options', 'Похожие варианты'), text: t('მაჩვენე მსგავსი ვარიანტები: {ref}', 'Show me options similar to {ref}', 'Покажи варианты, похожие на {ref}') },
  market: { label: t('რა ღირს ასეთი ბიზნესი {city}', 'Prices for this in {city}', 'Цены на такой бизнес: {city}'), text: t('რა ღირს საშუალოდ {sector} {city} და რა უნდა ველოდო?', 'What does a {sector} typically cost in {city} and what should I expect?', 'Сколько обычно стоит {sector} в {city} и чего ожидать?') },
  best: { label: t('რომელი ჯობია ჩემთვის?', 'Which is better for me?', 'Какой лучше для меня?'), text: t('რომელი ჯობია ჩემთვის და რატომ?', 'Which of these is better for me, and why?', 'Какой из них лучше для меня и почему?') },
  risks_each: { label: t('რისკები თითოეულისთვის', 'Risks of each', 'Риски каждого'), text: t('რა რისკებია თითოეულ ვარიანტში?', 'What are the risks of each option?', 'Какие риски у каждого варианта?') },
  locations: { label: t('ლოკაციების შედარება', 'Compare locations', 'Сравнить локации'), text: t('შეადარე ამ ვარიანტების ლოკაციები და კონკურენცია', 'Compare the locations and competition of these options', 'Сравни локации и конкуренцию этих вариантов') },
  show: { label: t('მაჩვენე ვარიანტები', 'Show me options', 'Покажи варианты'), text: t('მაჩვენე ვარიანტები', 'Show me options', 'Покажи варианты') },
  district: { label: t('რომელი უბანი ჯობია', 'Which district is best', 'Какой район лучше'), text: t('რომელი უბანი ჯობია {sector} {city} და რატომ?', 'Which district of {city} is best for a {sector}, and why?', 'Какой район {city} лучше для бизнеса «{sector}» и почему?') },
  check: { label: t('რა შევამოწმო შეძენამდე', 'What to check before buying', 'Что проверить перед покупкой'), text: t('რა უნდა შევამოწმო ბიზნესის შეძენამდე?', 'What should I check before buying a business?', 'Что нужно проверить перед покупкой бизнеса?') },
  market_sector: { label: t('ბაზრის მონაცემები: {sector}', 'Market data: {sector}', 'Данные рынка: {sector}'), text: t('რა ღირს საშუალოდ {sector} {city} და რამდენია გასაყიდად?', 'What does a {sector} cost in {city} and how many are for sale?', 'Сколько стоит {sector} в {city} и сколько продаётся?') },
  listings_sector: { label: t('{sector} — განცხადებები', '{sector} listings', '{sector} — объявления'), text: t('მაჩვენე {sector} {city}', 'Show me {sector} listings in {city}', 'Покажи объявления: {sector}, {city}') },
  more: { label: t('კიდევ ვარიანტები', 'More options', 'Ещё варианты'), text: t('მაჩვენე კიდევ ვარიანტები', 'Show me more options', 'Покажи ещё варианты') },
}

// Georgian takes the city in the locative ("თბილისში"): -ი/-ე endings become -ში.
export function inCity(city: string, locale: string): string {
  if (locale !== 'ka' || !city) return city
  return city.replace(/[იე]$/u, '') + 'ში'
}
