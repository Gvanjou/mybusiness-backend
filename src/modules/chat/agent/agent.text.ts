// Streams the model's text through, but holds back markup the model sometimes writes instead of calling a tool:
// "<script …>…</script>", "<form>{…}</form>", "<options>…</options>", fenced ``` blocks. The buyer never sees them;
// each held block is kept so the turn can still act on it (its options become chips, its facts go to the profile).
// A partial opener at the end of a chunk ("<fo", "``") is kept until the next chunk shows what it is.

const OPENER = /<(script|form|options|json|tool_call|tool|suggest[\w-]*|function[\w-]*|reply_options)\b[^>]*>|```/i

export type HiddenBlock = { tag: string; body: string }

// Could the tail of the text be the start of an opener? ("<", "<scr", "`", "``")
function heldFrom(s: string): number {
  const lt = s.lastIndexOf('<')
  if (lt >= 0 && s.length - lt <= 24 && /^<[\w-]*(\s[^>]*)?$/.test(s.slice(lt))) return lt
  const tick = s.match(/`{1,2}$/)
  if (tick) return s.length - tick[0].length
  return -1
}

export function createTextFilter() {
  let held = '' // a possible start of a hidden block, waiting for more text
  let hidden: { tag: string; close: string; body: string } | null = null
  const blocks: HiddenBlock[] = []
  // A block removed between two sentences leaves one space, so they are not glued together.
  let gap = false

  const push = (chunk: string): string => {
    let s = held + chunk
    held = ''
    let out = ''
    const visible = (text: string) => {
      if (gap && text && !/^\s/.test(text)) out += ' '
      if (text) gap = false
      out += text
    }
    for (;;) {
      if (hidden) {
        const at = s.toLowerCase().indexOf(hidden.close)
        if (at === -1) {
          hidden.body += s
          return out
        }
        blocks.push({ tag: hidden.tag, body: hidden.body + s.slice(0, at) })
        s = s.slice(at + hidden.close.length)
        hidden = null
        gap = true
        continue
      }
      const m = s.match(OPENER)
      if (!m) break
      const tag = m[1] ? m[1].toLowerCase() : 'fence'
      // Text before a hidden block loses its trailing blank space; the block itself goes nowhere visible.
      visible(s.slice(0, m.index).replace(/\s+$/, ''))
      hidden = { tag, close: tag === 'fence' ? '```' : `</${tag}>`, body: '' }
      s = s.slice(m.index! + m[0].length)
    }
    const from = heldFrom(s)
    if (from >= 0) {
      const cut = s.slice(0, from).replace(/\s+$/, '').length
      held = s.slice(cut)
      visible(s.slice(0, cut))
      return out
    }
    visible(s)
    return out
  }

  return {
    push,
    // Whatever is still held (it was not a hidden block after all), every hidden block, and the options they carried.
    end(): { rest: string; options: string[]; blocks: HiddenBlock[] } {
      const rest = hidden ? '' : held
      if (hidden) blocks.push({ tag: hidden.tag, body: hidden.body + held })
      held = ''
      hidden = null
      return { rest, options: blocks.flatMap((b) => optionsIn(b.body)), blocks }
    },
  }
}

function optionsIn(body: string): string[] {
  const list = body.match(/"options"\s*:\s*(\[[\s\S]*?\])/)?.[1]
  try {
    const parsed: unknown = list ? JSON.parse(list) : []
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string' && o.trim().length > 0 && o.length <= 60).map((o) => o.trim()) : []
  } catch {
    return []
  }
}

// Facts about the client that a hidden block spelled out ({"budget_gel": 30000, "cities": ["Batumi"]}), in the shape
// update_profile takes, so they are not lost.
export function profileArgsIn(blocks: HiddenBlock[]): Record<string, unknown> | null {
  const keys = ['budget_gel', 'goal', 'involvement', 'experience', 'risk', 'cities', 'sectors', 'location_flexible', 'capital_share']
  for (const b of blocks) {
    const json = b.body.match(/\{[\s\S]*\}/)?.[0]
    if (!json) continue
    try {
      const obj = JSON.parse(json) as Record<string, unknown>
      const found = Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)))
      if (Object.keys(found).length) return found
    } catch {
      // not JSON: nothing to keep
    }
  }
  return null
}

// Markdown tables the model writes despite the rules ("| შემოსავალი | 20 000 |"): the app shows its own computed
// tables, so a second set of numbers never reaches the buyer.
export function withoutTables(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\|.*\|\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// The first sentence (or the part before " — ") of a later step, held until it is complete and dropped when it only
// repeats the text before it: at least three words, nearly all already said. A bold name or a "#n" is never dropped.
export function createRepeatCheck(before: string) {
  const said = new Set(wordsOf(before))
  let held: string | null = '' // null once decided: the rest of the step passes through
  const decide = (sentence: string): string => {
    const words = wordsOf(sentence)
    const repeats = !/\*\*|#/.test(sentence) && words.length >= 3 && words.filter((w) => said.has(w)).length >= 0.8 * words.length
    return repeats ? '' : sentence
  }
  return {
    push(chunk: string): string {
      if (held === null) return chunk
      held += chunk
      const end = held.match(/[.!?…]\s|\n| — /)
      if (!end) {
        // No sentence end within 240 characters: nothing can be judged a repeat, and cutting at a chunk boundary
        // once lost the start of a word ("ცხადებაში" for "განცხადებაში"). Everything passes through.
        if (held.length < 240) return ''
        const all = held
        held = null
        return all
      }
      const cut = end.index! + end[0].length
      const first = decide(held.slice(0, cut))
      const rest = held.slice(cut)
      held = null
      return first ? first + rest : rest.replace(/^\s+/, '')
    },
    // The step ended while its first sentence was still held.
    end(): string {
      const last = held === null ? '' : decide(held)
      held = null
      return last
    },
  }
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/\p{L}{2,}/gu) ?? []

// Letters from another alphabet that look like the reply's own: the model sometimes writes an Armenian "լ" inside a
// Georgian word ("პլუსები", round 6) or a Latin "o" inside a Russian one. Each is replaced by the letter it imitates.
// The text is handled chunk by chunk, so a Russian word split across two chunks may keep its Latin letter.
const GEORGIAN_LOOKALIKES: Record<string, string> = { 'լ': 'ლ' }
const CYRILLIC_LOOKALIKES: Record<string, string> = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' }

export function fixScript(text: string, locale: 'ka' | 'en' | 'ru'): string {
  // A Georgian word with Greek, Cyrillic or Armenian letters in it ("ασსაფრთხოა"): a lookalike becomes its Georgian
  // letter, anything else is dropped. A word in another script on its own (Wolt, Glovo) stays.
  if (locale === 'ka') return text.replace(/\p{L}+/gu, (word) => (/[ა-ჰ]/.test(word) ? word.replace(/[\u0370-\u03ff\u0400-\u04ff\u0530-\u058f]/g, (ch) => GEORGIAN_LOOKALIKES[ch] ?? '') : word))
  if (locale === 'ru') return text.replace(/[\p{L}]+/gu, (word) => (/[а-яё]/i.test(word) && /[a-z]/i.test(word) ? word.replace(/[a-zA-Z]/g, (ch) => CYRILLIC_LOOKALIKES[ch] ?? ch) : word))
  return text
}
