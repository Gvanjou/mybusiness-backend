// First line of scope control: deterministic checks that run before any model call.
// They catch the clear cases (code, jailbreaks) for free; the router model handles subtler off-topic requests.

export type GuardVerdict = 'off_topic' | 'unsafe' | null

// Source code pasted into the message.
const codeSyntax = [
  /```/,
  /^\s*(def|class)\s+\w+.*:\s*$/m,
  /^\s*(import\s+[\w.{}*, ]+(\s+from\s+['"][^'"]+['"])?|from\s+[\w.]+\s+import\s+)/m,
  /^\s*(function\s+\w+\s*\(|const\s+\w+\s*=\s*(\(|async|function)|let\s+\w+\s*=|var\s+\w+\s*=)/m,
  /^\s*#include\s*</m,
  /\b(public|private)\s+(static\s+)?(void|class|int|string)\b/i,
  /\bconsole\.log\(|\bprint\(\s*['"]|\bSystem\.out\.print/,
  /\bSELECT\s+[\w*, ]+\s+FROM\s+\w+/i,
  /<\/?(script|div|html|body|style)\b/i,
]

// Asking the assistant to produce or fix code, in any of the three languages.
const codeRequest = [
  /\b(write|create|generate|make|fix|debug|refactor|explain|convert|optimi[sz]e|review|complete)\b.{0,50}\b(code|script|function|program|class|python|javascript|typescript|java|c\+\+|c#|php|golang|rust|sql|query|regex|html|css|api|bot)\b/i,
  /\b(python|javascript|typescript|java|php|sql|regex|html|css)\b.{0,30}\b(code|script|function|program|snippet|example|tutorial|error|bug)\b/i,
  /(დამიწერე|დაწერე|გამისწორე|ამიხსენი|შექმენი).{0,40}(კოდ|სკრიპტ|ფუნქცი|პროგრამ|python|პითონ|javascript|sql)/i,
  /(напиши|напишите|исправь|исправьте|объясни|создай|сгенерируй).{0,40}(код|скрипт|функци|программ|python|питон|javascript|sql)/i,
]

// Attempts to override the assistant's rules or extract its instructions.
const jailbreak = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,30}\b(instructions?|rules?|prompt|guidelines|restrictions?|system)\b/i,
  /\b(system|initial|hidden)\s+prompt\b/i,
  /\b(developer|god|dan|jailbreak|unrestricted)\s+mode\b|\bjailbreak\b/i,
  /\b(you are now|from now on you are|act as|pretend (to be|you are)|roleplay as|role-play as)\b/i,
  /\brepeat (the|your) (text|words|instructions) above\b/i,
  /(დაივიწყე|უგულებელყავი|დაარღვიე).{0,30}(ინსტრუქცი|წეს|პრომპტ)/i,
  /(игнорируй|забудь|отмени|обойди).{0,30}(инструкци|правил|промпт|ограничени)/i,
  /системн\w*\s+промпт/i,
]

// Everyday subjects outside this assistant's scope. A message that also talks about business stays in scope
// ("a khachapuri business", "a fitness club for sale").
const offTopicSubject =
  /football|soccer|basketball|championship|world cup|weather|recipe|how (do|to) (i )?(cook|bake|make (a )?(cake|pizza|soup))|movie|film|tv series|song|lyrics|music|video game|celebrit|politic|election|president|religio|horoscope|joke|poem|girlfriend|boyfriend|homework|translate (this|into)|symptom|disease|medicine for|diet plan|workout|ფეხბურთ|კალათბურთ|ჩემპიონატ|ამინდ|რეცეპტ|მოვამზადო|მოვხარშო|გამოვაცხო|ფილმ|სერიალ|სიმღერ|მუსიკ|კომპიუტერულ თამაშ|არჩევნ|პოლიტიკ|პრეზიდენტ|რელიგი|ჰოროსკოპ|ანეკდოტ|ლექსი დამიწერე|შეყვარებულ|საშინაო დავალებ|თარგმნე|ავადმყოფ|წამალ|დიეტ|ვარჯიშ|футбол|баскетбол|чемпионат|погод|рецепт|как приготовить|фильм|сериал|песн|музык|компьютерн\S* игр|выбор|политик|президент|религи|гороскоп|анекдот|стих|девушк|парн\S* (мой|моего)|домашн\S* задани|переведи|симптом|лекарств|диет|тренировк/i
const businessContext =
  /business|invest|profit|revenue|listing|buy|sell|ბიზნეს|ინვესტ|მოგებ|შემოსავ|ყიდვ|გაყიდ|განცხადებ|იყიდება|ფართ|კაფე|რესტორ|სასტუმრ|მაღაზი|бизнес|инвест|прибыл|выручк|купить|продать|объявлен|кафе|ресторан|магазин/i

export function screenMessage(text: string): GuardVerdict {
  if (jailbreak.some((p) => p.test(text))) return 'unsafe'
  if (codeSyntax.some((p) => p.test(text))) return 'off_topic'
  if (codeRequest.some((p) => p.test(text))) return 'off_topic'
  if (offTopicSubject.test(text) && !businessContext.test(text)) return 'off_topic'
  return null
}

// Second line, on the way out: the model must never produce code. Checked on the streamed text.
export function looksLikeCode(reply: string): boolean {
  return /```|^\s*(def |class |import |function |const \w+ = )/m.test(reply)
}
