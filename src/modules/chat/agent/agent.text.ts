// Streams the model's text through, but holds back a "<script …>…</script>" block (or anything after "<script")
// that a model sometimes writes instead of calling suggest_replies. The held block is parsed for its options.
// A partial "<scr" at the end of a chunk is kept until the next chunk shows what it is.

const OPEN = '<script'

export function createTextFilter() {
  let held = '' // a possible start of a hidden block, waiting for more text
  let hidden: string | null = null // the hidden block once it has started

  return {
    push(chunk: string): string {
      if (hidden !== null) {
        hidden += chunk
        return ''
      }
      const s = held + chunk
      held = ''
      const at = s.indexOf(OPEN)
      if (at >= 0) {
        hidden = s.slice(at)
        return s.slice(0, at).replace(/\s+$/, '')
      }
      // Keep back a trailing "<", "<s", … "<scrip" (and the blank lines before it): it may start a hidden block.
      const lt = s.lastIndexOf('<')
      if (lt >= 0 && OPEN.startsWith(s.slice(lt))) {
        const from = s.slice(0, lt).replace(/\s+$/, '').length
        held = s.slice(from)
        return s.slice(0, from)
      }
      return s
    },

    // Whatever is still held (not a hidden block after all), and the options a hidden block carried.
    end(): { rest: string; options: string[] } {
      const rest = hidden === null ? held : ''
      held = ''
      if (hidden === null) return { rest, options: [] }
      const block = hidden
      hidden = null
      const list = block.match(/"options"\s*:\s*(\[[\s\S]*?\])/)?.[1]
      try {
        const parsed: unknown = list ? JSON.parse(list) : []
        return { rest, options: Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === 'string' && o.trim().length > 0 && o.length <= 60).map((o) => o.trim()) : [] }
      } catch {
        return { rest, options: [] }
      }
    },
  }
}
