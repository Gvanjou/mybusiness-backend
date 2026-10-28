import type { Localized } from '../../shared/i18n/locale.js'
import type { Scope } from './competition.config.js'

const t = (ka: string, en: string, ru: string): Localized => ({ ka, en, ru })

export const C = {
  title: t('კონკურენცია', 'Competition', 'Конкуренция'),
  scope: {
    hyperlocal: t('ამ ტიპის ბიზნესის კონკურენცია ლოკალურია: მომხმარებლები ახლომდებარე ობიექტებს შორის ირჩევენ (დაახლოებით {r} მ რადიუსში).', 'Competition for this kind of business is local: customers choose between places nearby (about {r} m).', 'Конкуренция для такого бизнеса локальная: клиенты выбирают между ближайшими заведениями (примерно {r} м).'),
    destination: t('კონკურენცია იმავე ქალაქში ან კურორტზეა; მოთხოვნას ძირითადად ტურისტები ქმნიან და ის სეზონურია.', 'Competition is within the same town or resort; demand comes mostly from tourists and is seasonal.', 'Конкуренция — в том же городе или курорте; спрос создают в основном туристы, и он сезонный.'),
    city: t('კონკურენცია ქალაქის მასშტაბითაა: გადამწყვეტია რეპუტაცია, შეფასებები და მარკეტინგი, ვიდრე ზუსტი მისამართი.', 'Competition is city-wide: reputation, reviews and marketing matter more than the exact address.', 'Конкуренция в масштабе города: репутация, отзывы и маркетинг важнее точного адреса.'),
    national: t('მდებარეობას ნაკლები მნიშვნელობა აქვს: კონკურენცია ეროვნულ ან ონლაინ დონეზეა (სავაჭრო ქსელები, მარკეტპლეისები, იმპორტი).', 'Location matters less: competition is national or online (retail chains, marketplaces, imports).', 'Расположение менее важно: конкуренция национальная или онлайн (сети, маркетплейсы, импорт).'),
    export: t('კონკურენცია პროდუქტის სეგმენტისა და გაყიდვის არხების მიხედვითაა (ექსპორტი, სავაჭრო ქსელები, რესტორნები).', 'Competition depends on the product segment and sales channels (export, retail chains, restaurants).', 'Конкуренция зависит от сегмента продукта и каналов продаж (экспорт, сети, рестораны).'),
    property: t('ეს ქონებაა: კონკურენცია = სხვა მსგავსი ფართები, რომლებიც იმავე ზონაში ქირავდება ან იყიდება.', 'This is property: competition = similar spaces for rent or sale in the same area.', 'Это недвижимость: конкуренция — похожие помещения в аренду или на продажу в том же районе.'),
  } satisfies Record<Scope, Localized>,
  level: {
    high: t('მაღალი', 'High', 'Высокая'),
    medium: t('საშუალო', 'Medium', 'Средняя'),
    low: t('დაბალი', 'Low', 'Низкая'),
    unknown: t('უცნობია', 'Unknown', 'Неизвестно'),
  },
  levelLabel: t('კონკურენციის დონე', 'Competition level', 'Уровень конкуренции'),
  nearby: t('{r} მ რადიუსში', 'Within {r} m', 'В радиусе {r} м'),
  nearbyValue: t('მინიმუმ {n}', 'at least {n}', 'не менее {n}'),
  nearest: t('უახლოესი კონკურენტები', 'Nearest competitors', 'Ближайшие конкуренты'),
  forSaleCity: t('მსგავსი იყიდება ({city})', 'Similar for sale ({city})', 'Похожие на продаже ({city})'),
  forSaleDistrict: t('მსგავსი იყიდება ({district})', 'Similar for sale ({district})', 'Похожие на продаже ({district})'),
  osmNote: t('ახლომდებარე ობიექტები OpenStreetMap-იდანაა; რუკა სრული არ არის, ამიტომ რეალური რიცხვი შეიძლება მეტი იყოს. ადგილზე დათვლა აუცილებელია.', 'Nearby places come from OpenStreetMap; the map is incomplete, so the real number may be higher. Count on site too.', 'Объекты рядом взяты из OpenStreetMap; карта неполная, реальное число может быть больше. Обязательно посчитайте на месте.'),
  noLocation: t('ზუსტი მდებარეობა უცნობია, ამიტომ ახლომდებარე კონკურენტებს ვერ დავთვლი — მოითხოვეთ მისამართი.', 'The exact location is unknown, so nearby competitors cannot be counted — ask for the address.', 'Точное расположение неизвестно, поэтому конкурентов рядом не посчитать — запросите адрес.'),
  mapUnavailable: t('რუკის მონაცემები ახლა მიუწვდომელია; ახლომდებარე კონკურენტები ადგილზე შეამოწმეთ.', 'Map data is unavailable right now; check nearby competitors on site.', 'Картографические данные сейчас недоступны; проверьте конкурентов на месте.'),
  saturated: t('იმავე ქალაქში {n} მსგავსი ბიზნესი იყიდება — შეიძლება ბაზარი გაჯერებული იყოს ან მოთხოვნა იკლებდეს.', '{n} similar businesses are for sale in the same city — the market may be saturated or demand falling.', 'В том же городе продаётся {n} похожих бизнесов — рынок может быть насыщен или спрос падает.'),
  risks: {
    high: t('მაღალი ლოკალური კონკურენცია: მინიმუმ {n} {type} {r} მ-ში.', 'High local competition: at least {n} {type} within {r} m.', 'Высокая локальная конкуренция: не менее {n} ({type}) в радиусе {r} м.'),
    medium: t('საშუალო ლოკალური კონკურენცია: მინიმუმ {n} {type} {r} მ-ში.', 'Moderate local competition: at least {n} {type} within {r} m.', 'Умеренная локальная конкуренция: не менее {n} ({type}) в радиусе {r} м.'),
    national: t('კონკურენცია ეროვნულ/ონლაინ დონეზეა — შეამოწმეთ, რით გამოირჩევა ბიზნესი ქსელებისა და მარკეტპლეისების ფონზე.', 'Competition is national/online — check what sets the business apart from chains and marketplaces.', 'Конкуренция национальная/онлайн — проверьте, чем бизнес выделяется на фоне сетей и маркетплейсов.'),
  },
  question: t('რამდენი კონკურენტია ახლომახლო და როგორ შეიცვალა გაყიდვები ახალი კონკურენტის გამოჩენის შემდეგ?', 'How many competitors are nearby, and how did sales change when a new one opened?', 'Сколько конкурентов рядом и как изменились продажи, когда открылся новый?'),
  types: {
    cafe: t('კაფე', 'cafés', 'кафе'),
    restaurant: t('რესტორანი', 'restaurants', 'ресторанов'),
    fast_food: t('სწრაფი კვება', 'fast food places', 'фастфудов'),
    food: t('კაფე/რესტორანი', 'cafés and restaurants', 'кафе и ресторанов'),
    bakery: t('საცხობი', 'bakeries', 'пекарен'),
    bar: t('ბარი', 'bars', 'баров'),
    pub: t('პაბი', 'pubs', 'пабов'),
    nightclub: t('ღამის კლუბი', 'nightclubs', 'ночных клубов'),
    pharmacy: t('აფთიაქი', 'pharmacies', 'аптек'),
    supermarket: t('სუპერმარკეტი', 'supermarkets', 'супермаркетов'),
    convenience: t('მარკეტი', 'convenience stores', 'магазинов у дома'),
    clothes: t('ტანსაცმლის მაღაზია', 'clothing stores', 'магазинов одежды'),
    hairdresser: t('სილამაზის სალონი', 'salons', 'салонов'),
    beauty: t('სილამაზის სალონი', 'beauty salons', 'салонов красоты'),
    massage: t('მასაჟის სალონი', 'massage salons', 'массажных салонов'),
    fitness_centre: t('ფიტნეს ცენტრი', 'gyms', 'фитнес-центров'),
    clinic: t('კლინიკა', 'clinics', 'клиник'),
    doctors: t('სამედიცინო კაბინეტი', 'medical practices', 'медкабинетов'),
    car_wash: t('ავტოსამრეცხაო', 'car washes', 'автомоек'),
    car_repair: t('ავტოსერვისი', 'car repair shops', 'автосервисов'),
    hotel: t('სასტუმრო', 'hotels', 'гостиниц'),
    guest_house: t('სასტუმრო სახლი', 'guest houses', 'гостевых домов'),
    hostel: t('ჰოსტელი', 'hostels', 'хостелов'),
    places: t('მსგავსი ობიექტი', 'similar places', 'похожих заведений'),
  } as Record<string, Localized>,
  chip: t('როგორია კონკურენცია ამ ადგილას?', 'What is the competition like?', 'Какая конкуренция?'),
  // Direct answer to "what does this competition mean for me if I buy?"
  meaningTitle: t('რას ნიშნავს ეს კონკურენცია, თუ ამ ბიზნესს შეიძენთ', 'What this competition means if you buy this business', 'Что эта конкуренция значит, если вы купите этот бизнес'),
  meaning: {
    high: [
      t('მომხმარებელს ბევრი ალტერნატივა აქვს, ამიტომ ფასსა და ხარისხზე მუდმივი წნეხი იქნება — მოგების მარჟა შეიძლება დაბალი იყოს.', 'Customers have many alternatives, so there will be constant pressure on price and quality — margins may be thin.', 'У клиентов много альтернатив, поэтому будет постоянное давление на цену и качество — маржа может быть низкой.'),
      t('შემოსავალი დამოკიდებული იქნება იმაზე, რით გამოირჩევა ობიექტი: მდებარეობა, მენიუ ან ასორტიმენტი, ფასი, მომსახურება, ერთგული კლიენტები.', 'Revenue will depend on what makes this place stand out: location, menu or range, price, service, loyal customers.', 'Выручка будет зависеть от того, чем заведение выделяется: локация, меню или ассортимент, цена, сервис, постоянные клиенты.'),
      t('ახლოს ახალი კონკურენტის გახსნამ ან მეზობლის ფასდაკლებამ შეიძლება გაყიდვები სწრაფად შეამციროს.', 'A new competitor opening nearby or a neighbour cutting prices can quickly reduce sales.', 'Открытие нового конкурента рядом или скидки соседа могут быстро снизить продажи.'),
      t('დადებითი მხარე: ბევრი მსგავსი ობიექტი ხშირად ნიშნავს ხალხმრავალ, მოთხოვნად ზონას — მთავარია, მომხმარებელმა სწორედ თქვენთან რატომ უნდა მოვიდეს.', 'The upside: many similar places often means a busy area with real demand — the key is why customers should choose you.', 'Плюс: много похожих заведений часто означает оживлённое место со спросом — главное, почему клиенты должны выбрать вас.'),
    ],
    medium: [
      t('კონკურენცია ზომიერია: ადგილი ჯერ კიდევ არის, მაგრამ ფასი და ხარისხი კონკურენტებს უნდა შეედაროს.', 'Competition is moderate: there is room, but price and quality must hold up against neighbours.', 'Конкуренция умеренная: место есть, но цена и качество должны выдерживать сравнение с соседями.'),
      t('ერთი ძლიერი ახალი კონკურენტის გამოჩენამ შეიძლება ბალანსი შეცვალოს — ჰკითხეთ გამყიდველს, როგორ შეიცვალა გაყიდვები ბოლო წლებში.', 'One strong new competitor could change the balance — ask the seller how sales changed in recent years.', 'Один сильный новый конкурент может изменить баланс — спросите продавца, как менялись продажи в последние годы.'),
    ],
    low: [
      t('ახლოს მსგავსი ობიექტები ცოტაა — ეს უპირატესობაა, თუ ზონაში მოთხოვნა არსებობს. შეამოწმეთ, ცოტა კონკურენტი ცოტა მყიდველს ხომ არ ნიშნავს.', 'There are few similar places nearby — an advantage if there is demand. Check that few competitors does not mean few customers.', 'Похожих заведений рядом мало — это плюс, если есть спрос. Проверьте, не означает ли мало конкурентов мало покупателей.'),
    ],
    unknown: [
      t('ზუსტი მისამართის გარეშე ლოკალურ კონკურენციას ვერ შევაფასებ — ეს ყიდვამდე აუცილებლად უნდა გაირკვეს.', 'Without the exact address I cannot assess local competition — this must be clarified before buying.', 'Без точного адреса локальную конкуренцию не оценить — это нужно выяснить до покупки.'),
    ],
  },
  thisListing: t('ამ განცხადების შემთხვევაში: {facts}.', 'For this listing: {facts}.', 'Для этого объявления: {facts}.'),
  factNearby: t('{r} მ-ში მინიმუმ {n} {type}', 'at least {n} {type} within {r} m', 'не менее {n} ({type}) в радиусе {r} м'),
  factForSale: t('{cityIn} {n} მსგავსი ბიზნესი იყიდება', '{n} similar businesses are for sale in {cityIn}', 'в {cityIn} продаётся {n} похожих бизнесов'),
  checkTitle: t('ყიდვამდე შეამოწმეთ', 'Check before buying', 'Проверьте до покупки'),
}
