import type { Localized } from '../../shared/i18n/locale.js'

const t = (ka: string, en: string, ru: string): Localized => ({ ka, en, ru })

// Texts for the location verdict ("will this business work here?") and the area scan for commercial spaces.
export const LOC = {
  verdict: {
    favourable: {
      title: t('ადგილი ხელსაყრელია', 'The location looks favourable', 'Место выглядит удачным'),
      text: t(
        'ახლოს მსგავსი ობიექტი ცოტაა, ზონაში კი სხვა ბიზნესები აქტიურად მუშაობს — ეს მოთხოვნის კარგი ნიშანია. მაინც გადაამოწმეთ ხალხის ნაკადი ადგილზე, პიკის საათებში.',
        'There are few similar places nearby, and other businesses around are active — a good sign of demand. Still check foot traffic on site at peak hours.',
        'Похожих заведений рядом мало, а вокруг работают другие бизнесы — хороший признак спроса. Всё равно проверьте поток людей на месте в часы пик.',
      ),
    },
    workable: {
      title: t('შესაძლებელია, პირობებით', 'Workable, with conditions', 'Возможно, при условиях'),
      text: t(
        'ზონაში კონკურენცია ზომიერია. აქ ბიზნესი იმუშავებს, თუ ფასით ან ხარისხით მეზობლებს არ ჩამორჩება — ყიდვამდე ნახეთ, რამდენი კლიენტი ჰყავთ უახლოეს კონკურენტებს.',
        'Competition here is moderate. A business can work if it keeps up with neighbours on price or quality — before buying, see how many customers the nearest competitors get.',
        'Конкуренция умеренная. Бизнес может работать, если не уступает соседям по цене или качеству — до покупки посмотрите, сколько клиентов у ближайших конкурентов.',
      ),
    },
    tough: {
      title: t('ამ ადგილას რისკი მაღალია', 'High risk at this location', 'Высокий риск в этом месте'),
      text: t(
        'ზონა ამ ტიპის ბიზნესით გაჯერებულია. აქ ის გაამართლებს მხოლოდ მაშინ, თუ მკაფიოდ გამოირჩევა (ფასი, ხარისხი, კონცეფცია) ან უკვე ჰყავს ერთგული კლიენტები — ამის გარეშე დიდი რისკია, რომ შემოსავალი ვერ შენარჩუნდება.',
        'The area is saturated with this kind of business. It will only pay off here if it clearly stands out (price, quality, concept) or already has loyal customers — otherwise there is a real risk that revenue will not hold.',
        'Район насыщен такими заведениями. Здесь бизнес окупится, только если явно выделяется (цена, качество, концепция) или уже имеет постоянных клиентов — иначе велик риск, что выручка не удержится.',
      ),
    },
    weak_demand: {
      title: t('ფრთხილად: ზონა მშვიდია', 'Careful: the area is quiet', 'Осторожно: район тихий'),
      text: t(
        'კონკურენტი თითქმის არ არის, მაგრამ ირგვლივ სხვა ობიექტებიც ცოტაა. ეს შეიძლება ნიშნავდეს, რომ აქ საკმარისი მომხმარებელი უბრალოდ არ არის — ასეთ ადგილას ბიზნესი, რომელიც გამვლელებზეა დამოკიდებული, ხშირად ვერ მუშაობს.',
        'There are almost no competitors, but few other businesses around either. That can mean there simply are not enough customers here — businesses that depend on passers-by often fail in places like this.',
        'Конкурентов почти нет, но и других заведений вокруг мало. Это может значить, что здесь просто мало клиентов — бизнес, зависящий от проходящих людей, в таких местах часто не работает.',
      ),
    },
    unknown: {
      title: t('ადგილის შეფასება შეუძლებელია', 'The location cannot be assessed yet', 'Место пока не оценить'),
      text: t(
        'ზუსტი მისამართის გარეშე ვერ ვიტყვი, იმუშავებს თუ არა აქ ბიზნესი. მოითხოვეთ მისამართი — შემდეგ ზონას დეტალურად გავაანალიზებ.',
        'Without the exact address I cannot say whether a business will work here. Ask for the address — then I can analyse the area in detail.',
        'Без точного адреса нельзя сказать, будет ли здесь работать бизнес. Запросите адрес — тогда я подробно проанализирую район.',
      ),
    },
  },
  verdictFacts: t('{r} მ-ში მინიმუმ {n} {type}; ზონაში სულ ~{total} ობიექტი ({busy}).', 'At least {n} {type} within {r} m; about {total} places in the area overall ({busy}).', 'В радиусе {r} м не менее {n} ({type}); всего около {total} заведений вокруг ({busy}).'),
  activityLabel: t('ზონის აქტიურობა (500 მ)', 'Area activity (500 m)', 'Активность района (500 м)'),
  busy: {
    busy: t('ხალხმრავალი ზონა', 'a busy area', 'оживлённый район'),
    moderate: t('საშუალოდ აქტიური ზონა', 'a moderately busy area', 'умеренно оживлённый район'),
    quiet: t('მშვიდი ზონა', 'a quiet area', 'тихий район'),
  },
  // Commercial space / property
  propertyTitle: t('ეს ფართია — შედეგი დამოკიდებულია იმაზე, რისთვის გამოიყენებთ', 'This is a space — the outcome depends on what you use it for', 'Это помещение — результат зависит от того, как вы его используете'),
  propertyIntro: t(
    'ფართისთვის „კონკურენცია“ ერთი არ არის: აფთიაქისთვის ეს ადგილი შეიძლება იდეალური იყოს, კაფესთვის კი — გაჯერებული. ამიტომ ვნახე, რა არის უკვე ირგვლივ და რა აკლია ზონას.',
    'A space has no single "competition": the same spot can be ideal for a pharmacy and saturated for a café. So I looked at what is already around and what the area lacks.',
    'У помещения нет одной «конкуренции»: то же место может быть идеальным для аптеки и перенасыщенным для кафе. Поэтому я посмотрел, что уже есть вокруг и чего не хватает району.',
  ),
  areaTitle: t('ზონის სურათი', 'The area', 'Район'),
  areaText: t('{r} მ-ში ~{total} ობიექტი — {busy}.', 'About {total} places within {r} m — {busy}.', 'Около {total} заведений в радиусе {r} м — {busy}.'),
  approx: t('(მიახლოებით: ზუსტი მისამართი უცნობია, ამიტომ ვაანალიზებ უბნის ცენტრს — {place})', '(approximate: the exact address is unknown, so this is the centre of {place})', '(приблизительно: точный адрес неизвестен, поэтому анализирую центр района — {place})'),
  gapsTitle: t('რა აკლია ზონას — შესაძლებლობები', 'What the area lacks — opportunities', 'Чего не хватает району — возможности'),
  saturatedTitle: t('რა არის უკვე გაჯერებული — აქ რისკიანია', 'Already saturated — risky here', 'Уже насыщено — здесь рискованно'),
  useLine: t('**{use}** — {r} მ-ში {n}', '**{use}** — {n} within {r} m', '**{use}** — {n} в радиусе {r} м'),
  tooSmall: t('ფართი ({area} მ²) ამისთვის მცირეა', 'the space ({area} m²) is small for this', 'площадь ({area} м²) для этого мала'),
  quietAdvice: t(
    'ზონა მშვიდია, ამიტომ გამვლელებზე დამოკიდებული ბიზნესი (კაფე, მაღაზია) აქ რისკიანია. უკეთ მოერგება ჩაწერით მომსახურება (სილამაზის სალონი, კლინიკა/კაბინეტი), ოფისი ან საწყობი.',
    'The area is quiet, so businesses that rely on passers-by (café, shop) are risky here. Appointment-based services (salon, clinic/practice), an office or storage fit better.',
    'Район тихий, поэтому бизнес, зависящий от прохожих (кафе, магазин), здесь рискован. Лучше подойдут услуги по записи (салон, клиника/кабинет), офис или склад.',
  ),
  rentTitle: t('თუ იჯარით გასცემთ', 'If you rent it out', 'Если сдавать в аренду'),
  rentText: t(
    'საიტზე {city} მსგავსი ფართების ქირა საშუალოდ ~{rent} ₾/მ² თვეში ({n} განცხადება). ამ ფართისთვის ეს ~{monthly} თვეში, ანუ წლიური უკუგება ფასიდან ~{yield}% (გადასახადამდე და ცარიელი თვეების გარეშე).',
    'On the site, similar spaces in {city} rent for about {rent} ₾/m² per month ({n} listings). For this space that is ~{monthly} a month, a gross yield of ~{yield}% a year on the price (before tax and empty months).',
    'На сайте похожие помещения в {city} сдаются примерно по {rent} ₾/м² в месяц ({n} объявл.). Для этого помещения это ~{monthly} в месяц, т.е. валовая доходность ~{yield}% годовых от цены (до налогов и простоя).',
  ),
  rentNoData: t(
    'იჯარის შემთხვევაში მთავარია: ქირა მ²-ზე ამ უბანში, რამდენ ხანს დგას ფართი ცარიელი და ვინ შეიძლება იყოს მოიჯარე (ზემოთ ჩამოთვლილი ბიზნესები). საიტზე შესადარებელი საიჯარო განცხადება საკმარისი არ არის.',
    'For renting out, what matters is rent per m² in this district, how long spaces stay empty and who the likely tenants are (the businesses listed above). There are not enough comparable rental listings on the site.',
    'Для сдачи в аренду важны: ставка за м² в этом районе, сколько помещения простаивают и кто вероятные арендаторы (бизнесы выше). Сопоставимых объявлений об аренде на сайте недостаточно.',
  ),
  tenantsTitle: t('ვინ შეიძლება იყოს მოიჯარე', 'Likely tenants', 'Кто может арендовать'),
  tenantsNote: t('ესენი ის ბიზნესებია, რომლებიც ზონას აკლია — მათთვის ეს ფართი ყველაზე მიმზიდველია.', 'These are the businesses the area lacks — for them this space is most attractive.', 'Это бизнесы, которых не хватает району — для них это помещение наиболее привлекательно.'),
  leaseRisks: t(
    'გაითვალისწინეთ: ფართი შეიძლება რამდენიმე თვე ცარიელი დადგეს, ქირიდან გადასახადი გადაიხდება და მოიჯარე ხშირად ითხოვს რემონტში მონაწილეობას. ყიდვამდე ჰკითხეთ გამყიდველს, ქირავდებოდა თუ არა ფართი და რა ფასად.',
    'Keep in mind: the space may stay empty for some months, rent income is taxed, and tenants often ask you to share fit-out costs. Before buying, ask the seller whether the space was rented out and at what rent.',
    'Учтите: помещение может простаивать несколько месяцев, доход от аренды облагается налогом, а арендаторы часто просят участия в ремонте. До покупки спросите продавца, сдавалось ли помещение и по какой ставке.',
  ),
  nextLease: t('გინდათ, შევამოწმო, რომელი მათგანისთვის იქნება ეს ადგილი ყველაზე კარგი?', 'Shall I check which of them this location suits best?', 'Проверить, для кого из них это место подходит лучше всего?'),
  businessScanTitle: t('რა აკლია ამ ზონას', 'What this area lacks', 'Чего не хватает району'),
  businessScanIntro: t(
    'ვნახე, რა ტიპის ობიექტებია უკვე ირგვლივ. ეს გამოგადგებათ, თუ ბიზნესის პროფილის შეცვლას ან დამატებით მომსახურებას განიხილავთ.',
    'I looked at what kinds of places are already around. Useful if you are thinking of changing the profile of the business or adding a service.',
    'Я посмотрел, какие заведения уже есть вокруг. Полезно, если вы думаете сменить профиль бизнеса или добавить услугу.',
  ),
  askBusiness: t('რომელი ვარიანტი გაინტერესებთ? აირჩიეთ და ამ კონკრეტულ ადგილს შევაფასებ.', 'Which option interests you? Pick one and I will assess it for this exact spot.', 'Какой вариант вас интересует? Выберите, и я оценю его именно для этого места.'),
  ask: t('რისთვის გამოიყენებდით ამ ფართს — საკუთარი ბიზნესისთვის თუ გასაქირავებლად? აირჩიეთ ვარიანტი და შესაბამის შესაძლებლობას შევაფასებ.', 'What do you plan to use this space for — your own business or renting it out? Pick below and I will analyse that option specifically.', 'Как вы планируете использовать помещение — для своего бизнеса или сдавать в аренду? Выберите ниже, и я разберу именно этот вариант.'),
  useChip: t('{use} აქ?', '{use} here?', '{use} здесь?'),
  useChipText: t('ამ ადგილას {use} რომ გავხსნა, რამდენად პერსპექტიული იქნება? [{id}]', 'Would a {use} work at this location? [{id}]', 'Будет ли здесь работать {use}? [{id}]'),
  leaseChip: t('იჯარით გაცემა', "I'll rent it out", 'Сдам в аренду'),
  leaseChipText: t('ამ ფართის იჯარით გაცემით რამდენი შემოსავლის მიღება შეიძლება? [{id}]', 'I would rent this space out — how much could it earn? [{id}]', 'Сдам это помещение в аренду — сколько это принесёт? [{id}]'),
  scanChip: t('რა ბიზნესი აკლია ამ ზონას?', 'What does this area lack?', 'Чего не хватает району?'),
  scanChipText: t('ამ ზონაში რომელი ტიპის ბიზნესი აკლია? [{id}]', 'What kind of business does this area lack? [{id}]', 'Какого бизнеса не хватает этому району? [{id}]'),
  // OpenStreetMap misses many shops: zero is a lead to verify, not a fact.
  unmapped: t('(რუკაზე არცერთი არ ჩანს — ადგილზე აუცილებლად გადაამოწმეთ)', '(none on the map — be sure to verify on site)', '(на карте ни одного — обязательно проверьте на месте)'),
  meaningPlanned: t('რას ნიშნავს ეს, თუ აქ ამ ბიზნესს გახსნით', 'What this means if you open it here', 'Что это значит, если открыть здесь'),
  plannedTitle: t('{use} ამ ადგილას', 'A {use} at this location', '{use} в этом месте'),
  nextBusiness: t('გინდათ, ვნახო, რა ტიპის ბიზნესი აკლია ამ ზონას, ან გადავიდეთ რისკებსა და ფასზე?', 'Shall I check what kind of business this area lacks, or shall we move on to risks and price?', 'Посмотреть, какого бизнеса не хватает району, или перейдём к рискам и цене?'),
  nextPlanned: t('შეგიძლიათ სხვა ვარიანტიც შეამოწმოთ ან ნახოთ, რას მოიტანს იჯარით გაცემა.', 'You can check another use or see what renting it out would bring.', 'Можно проверить другой вариант или посмотреть, что даст сдача в аренду.'),
}
