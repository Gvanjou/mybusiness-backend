import type { Locale, Localized } from '../../shared/i18n/locale.js'

const categories: Record<string, Localized> = {
  restaurants: { ka: 'რესტორანი', en: 'Restaurant', ru: 'Ресторан' },
  bakery: { ka: 'საცხობი / კაფე', en: 'Bakery / café', ru: 'Пекарня / кафе' },
  bar_nightclub: { ka: 'ბარი / ღამის კლუბი', en: 'Bar / nightclub', ru: 'Бар / ночной клуб' },
  hotels: { ka: 'სასტუმრო', en: 'Hotel', ru: 'Гостиница' },
  event_venue: { ka: 'ღონისძიებების დარბაზი', en: 'Event venue', ru: 'Банкетный зал' },
  retail: { ka: 'საცალო ვაჭრობა', en: 'Retail', ru: 'Розничная торговля' },
  commercial_space: { ka: 'კომერციული ფართი', en: 'Commercial space', ru: 'Коммерческая площадь' },
  supermarket: { ka: 'სუპერმარკეტი', en: 'Supermarket', ru: 'Супермаркет' },
  clothing_store: { ka: 'ტანსაცმლის მაღაზია', en: 'Clothing store', ru: 'Магазин одежды' },
  online: { ka: 'ონლაინ მაღაზია', en: 'Online store', ru: 'Онлайн-магазин' },
  e_commerce: { ka: 'ონლაინ ბიზნესი', en: 'E-commerce', ru: 'Онлайн-бизнес' },
  healthcare: { ka: 'მედიცინა', en: 'Healthcare', ru: 'Медицина' },
  pharmacy: { ka: 'აფთიაქი', en: 'Pharmacy', ru: 'Аптека' },
  dental: { ka: 'სტომატოლოგია', en: 'Dental clinic', ru: 'Стоматология' },
  spa: { ka: 'სპა / მასაჟი', en: 'Spa / massage', ru: 'Спа / массаж' },
  fitness_gym: { ka: 'ფიტნესი', en: 'Gym / fitness', ru: 'Фитнес' },
  beauty_sport: { ka: 'სილამაზე და სპორტი', en: 'Beauty & sport', ru: 'Красота и спорт' },
  auto_business: { ka: 'ავტობიზნესი', en: 'Auto business', ru: 'Автобизнес' },
  car_service: { ka: 'ავტოსერვისი', en: 'Car service', ru: 'Автосервис' },
  car_wash: { ka: 'ავტოსამრეცხაო', en: 'Car wash', ru: 'Автомойка' },
  real_estate: { ka: 'უძრავი ქონება', en: 'Real estate', ru: 'Недвижимость' },
  construction: { ka: 'სამშენებლო', en: 'Construction', ru: 'Строительство' },
  warehouse: { ka: 'საწყობი', en: 'Warehouse', ru: 'Склад' },
  manufacturing: { ka: 'წარმოება', en: 'Manufacturing', ru: 'Производство' },
  food_products: { ka: 'კვების პროდუქტები', en: 'Food products', ru: 'Продукты питания' },
  winery: { ka: 'ღვინის ქარხანა', en: 'Winery', ru: 'Винодельня' },
  agriculture: { ka: 'სოფლის მეურნეობა', en: 'Agriculture', ru: 'Сельское хозяйство' },
  offices: { ka: 'ოფისი', en: 'Office', ru: 'Офис' },
  services: { ka: 'მომსახურება', en: 'Services', ru: 'Услуги' },
  cleaning: { ka: 'დასუფთავება', en: 'Cleaning service', ru: 'Клининг' },
  printing: { ka: 'სტამბა', en: 'Printing', ru: 'Типография' },
  tourism: { ka: 'ტურიზმი', en: 'Tourism', ru: 'Туризм' },
  it_tech: { ka: 'IT ტექნოლოგიები', en: 'IT', ru: 'IT' },
  franchises: { ka: 'ფრანჩაიზი', en: 'Franchise', ru: 'Франшиза' },
  entertainment: { ka: 'გართობა', en: 'Entertainment', ru: 'Развлечения' },
  land: { ka: 'მიწა', en: 'Land', ru: 'Земля' },
  other: { ka: 'სხვა', en: 'Other', ru: 'Другое' },
}

const cities: Record<string, Localized> = {
  Tbilisi: { ka: 'თბილისი', en: 'Tbilisi', ru: 'Тбилиси' },
  Batumi: { ka: 'ბათუმი', en: 'Batumi', ru: 'Батуми' },
  Kutaisi: { ka: 'ქუთაისი', en: 'Kutaisi', ru: 'Кутаиси' },
  Rustavi: { ka: 'რუსთავი', en: 'Rustavi', ru: 'Рустави' },
  Mtskheta: { ka: 'მცხეთა', en: 'Mtskheta', ru: 'Мцхета' },
  Borjomi: { ka: 'ბორჯომი', en: 'Borjomi', ru: 'Боржоми' },
  Bakuriani: { ka: 'ბაკურიანი', en: 'Bakuriani', ru: 'Бакуриани' },
  Gudauri: { ka: 'გუდაური', en: 'Gudauri', ru: 'Гудаури' },
  Telavi: { ka: 'თელავი', en: 'Telavi', ru: 'Телави' },
  Gori: { ka: 'გორი', en: 'Gori', ru: 'Гори' },
  Zugdidi: { ka: 'ზუგდიდი', en: 'Zugdidi', ru: 'Зугдиди' },
  Kobuleti: { ka: 'ქობულეთი', en: 'Kobuleti', ru: 'Кобулети' },
  Kvareli: { ka: 'ყვარელი', en: 'Kvareli', ru: 'Кварели' },
  Sighnaghi: { ka: 'სიღნაღი', en: 'Sighnaghi', ru: 'Сигнахи' },
  Kaspi: { ka: 'კასპი', en: 'Kaspi', ru: 'Каспи' },
  Dusheti: { ka: 'დუშეთი', en: 'Dusheti', ru: 'Душети' },
  Stepantsminda: { ka: 'სტეფანწმინდა', en: 'Stepantsminda', ru: 'Степанцминда' },
}

const districts: Record<string, Localized> = {
  Vake: { ka: 'ვაკე', en: 'Vake', ru: 'Ваке' },
  Saburtalo: { ka: 'საბურთალო', en: 'Saburtalo', ru: 'Сабуртало' },
  Mtatsminda: { ka: 'მთაწმინდა', en: 'Mtatsminda', ru: 'Мтацминда' },
  Krtsanisi: { ka: 'კრწანისი', en: 'Krtsanisi', ru: 'Крцаниси' },
  Isani: { ka: 'ისანი', en: 'Isani', ru: 'Исани' },
  Samgori: { ka: 'სამგორი', en: 'Samgori', ru: 'Самгори' },
  Gldani: { ka: 'გლდანი', en: 'Gldani', ru: 'Глдани' },
  Nadzaladevi: { ka: 'ნაძალადევი', en: 'Nadzaladevi', ru: 'Надзаладеви' },
  Didube: { ka: 'დიდუბე', en: 'Didube', ru: 'Дидубе' },
  Chugureti: { ka: 'ჩუღურეთი', en: 'Chugureti', ru: 'Чугурети' },
  'Old Tbilisi': { ka: 'ძველი თბილისი', en: 'Old Tbilisi', ru: 'Старый Тбилиси' },
}

// "in Tbilisi": Georgian takes the locative ending (თბილისი → თბილისში, მცხეთა → მცხეთაში).
export function cityIn(city: string, locale: Locale): string {
  if (!city) return ''
  if (locale !== 'ka') return city
  return city.endsWith('ი') ? `${city.slice(0, -1)}ში` : `${city}ში`
}

export function districtLabel(district: string | null, locale: Locale): string {
  if (!district) return ''
  return districts[district]?.[locale] ?? district
}

export function categoryLabel(key: string, locale: Locale): string {
  return categories[key]?.[locale] ?? key.replace(/_/g, ' ')
}

// Business types named in a message ("რესტორანი მინდა", "хочу автомойку", "a car wash"), by the stem of each label in
// every language, matched at the start of a word so endings ("რესტორანს", "автомойку") still match. Generic ones
// ("other", "services") are left out: they say nothing about what the buyer wants.
const stems: [string, string[]][] = Object.entries(categories)
  .filter(([key]) => key !== 'other' && key !== 'services')
  .map(([key, l]) => [
    key,
    [l.ka, l.en, l.ru]
      .flatMap((x) => x.toLowerCase().split(/\s*\/\s*/))
      .map((x) => x.replace(/[აეიოუaeiouyаеиоуыяю]+$/u, ''))
      .filter((x) => x.length >= (/^[a-z]/.test(x) ? 4 : 3)), // "bar" would match "bargain"
  ])

export function categoriesNamed(text: string): string[] {
  const t = text.toLowerCase()
  return stems.filter(([, ss]) => ss.some((s) => new RegExp(`(?<!\\p{L})${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(t))).map(([key]) => key)
}

export function cityLabel(city: string | null, locale: Locale): string {
  if (!city) return ''
  return cities[city]?.[locale] ?? city
}

// Maps a city as typed by a user (any language) to the catalogue's English name.
export function normalizeCity(input: string, known: readonly string[]): string | null {
  const needle = input.trim().toLowerCase()
  if (!needle) return null
  const direct = known.find((c) => c.toLowerCase() === needle)
  if (direct) return direct
  for (const [en, names] of Object.entries(cities)) {
    if (Object.values(names).some((n) => n.toLowerCase() === needle)) return en
  }
  return known.find((c) => c.toLowerCase().startsWith(needle.slice(0, 5))) ?? null
}

export const knownCategoryKeys = Object.keys(categories)
