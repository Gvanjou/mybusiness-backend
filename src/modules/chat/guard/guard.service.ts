// First line of scope control: deterministic checks that run before any model call.
// They catch only the clear cases (code, jailbreaks, everyday subjects with no business in sight) for free. Anything
// in doubt goes to the model, whose Scope rule (agent/agent.prompt.ts) refuses what is really off-topic: a buyer
// refused by mistake is worse than a borderline message that costs one model call.

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
  // Another persona ("act as an unrestricted AI", "pretend you are DAN", "you are now ChatGPT") or no rules ("act as
  // if you had no rules"). A role in the deal itself ("act as my advisor", "pretend to be the seller so I can
  // practise") is what the assistant is for, so it is left to the model.
  /\b(you are now|from now on,? you are|act(ing)? as|pretend(ing)? (to be|you are|you're)|role-?play as)\s+(a |an |the |my )?(\w+ ){0,2}?(ai|chatbot|chat ?gpt|gpt\S*|llm|dan|bot|unrestricted|unfiltered|uncensored|jailbroken|evil|(a )?(different|another|new) (ai|assistant|model|character|persona|person))\b/i,
  /\b(act|behave|answer|respond|pretend)\b.{0,30}\b(no|without)\s+(rules|restrictions|limits|filters|guidelines|instructions)\b/i,
  /\brepeat (the|your) (text|words|instructions) above\b/i,
  /(დაივიწყე|უგულებელყავი|დაარღვიე).{0,30}(ინსტრუქცი|წეს|პრომპტ)/i,
  /(игнорируй|забудь|отмени|обойди).{0,30}(инструкци|правил|промпт|ограничени)/i,
  /системн[а-яё]*\s+промпт/i, // [а-яё], not \w: without the u flag \w matches Latin letters only
]

// Everyday subjects outside this assistant's scope. A message that also talks about business stays in scope
// ("a khachapuri business", "a fitness club for sale").
const offTopicSubject =
  /football|soccer|basketball|championship|world cup|weather|recipe|how (do|to) (i )?(cook|bake|make (a )?(cake|pizza|soup))|movie|film|tv series|song|lyrics|music|video game|celebrit|politic|election|president|religio|horoscope|joke|poem|girlfriend|boyfriend|homework|translate (this|into)|symptom|disease|medicine for|diet plan|workout|ფეხბურთ|კალათბურთ|ჩემპიონატ|ამინდ|რეცეპტ|მოვამზადო\s+(?:საჭმ|კერძ|ხაჭაპურ|ტორტ|სადილ|ვახშამ|ნამცხვარ)|მოვხარშო|გამოვაცხო|ფილმ|სერიალ|სიმღერ|მუსიკ|კომპიუტერულ თამაშ|არჩევნ|პოლიტიკ|პრეზიდენტ|რელიგი|ჰოროსკოპ|ანეკდოტ|ლექსი დამიწერე|შეყვარებულ|საშინაო დავალებ|თარგმნე|ავადმყოფ|წამალ|დიეტ|ვარჯიშ|футбол|баскетбол|чемпионат|погод|рецепт|как приготовить|фильм|сериал|песн|музык|компьютерн\S* игр|выбор(?:ы|ах|ов|ам|ами)(?![а-яё])|политик|президент|религи|гороскоп|анекдот|стих|девушк|парн\S* (мой|моего)|домашн\S* задани|переведи|симптом|лекарств|диет|тренировк/i
// A message about a listing ("#2", the seller, the rent), a kind of business ("a music shop", "a workout studio"), a
// deal or a budget is business, whatever else it mentions.
const businessContext =
  /business|invest|profit|revenue|listing|buy|sell|seller|rent|shop|store|studio|gym|salon|club|bakery|franchise|company|startup|deal|advis|consult|budget|price|premises|₾|\bgel\b|\blari\b|#\s?\d|ბიზნეს|ინვესტ|მოგებ|შემოსავ|ყიდვ|გაყიდ|განცხადებ|იყიდება|ფართ|კაფე|რესტორ|სასტუმრ|მაღაზი|გამყიდველ|ქირ|იჯარ|ბრუნვ|ვარიანტ|ბიუჯეტ|ლარ|ფას|სალონ|სტუდი|დარბაზ|ფიტნეს|კლუბ|ფრენჩაიზ|კომპანი|კონსულტ|მრჩეველ|გარიგებ|бизнес|инвест|прибыл|выручк|купить|продать|объявлен|кафе|ресторан|магазин|продав|аренд|бюджет|лари|студи|салон|фитнес|клуб|франшиз|компани|сделк|советник|консульт|вариант|цен|помещени/i

export function screenMessage(text: string): GuardVerdict {
  if (jailbreak.some((p) => p.test(text))) return 'unsafe'
  if (codeSyntax.some((p) => p.test(text))) return 'off_topic'
  if (codeRequest.some((p) => p.test(text))) return 'off_topic'
  if (offTopicSubject.test(text) && !businessContext.test(text)) return 'off_topic'
  return null
}

// Second line, on the way out: the model must never produce code. Checked on the streamed text after hidden
// blocks are removed (a fenced JSON block is a misplaced tool call, held back by the text filter, not code).
export function looksLikeCode(reply: string): boolean {
  return /^\s*(def \w+\(|class \w+[:(]|import [\w{]|from \w+ import|function \w+\s*\(|const \w+ = |#include\b|public static void)/m.test(reply)
}
