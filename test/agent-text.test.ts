import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTextFilter } from '../src/modules/chat/agent/agent.text.js'

// The model's text goes out as it arrives, except a hidden options block, which becomes chips.

function run(chunks: string[]) {
  const f = createTextFilter()
  const shown = chunks.map((c) => f.push(c)).join('')
  const { rest, options } = f.end()
  return { shown: shown + rest, options }
}

test('a hidden options block is held back, even when split across chunks, and its options are returned', () => {
  const r = run(['**→** შევადაროთ?\n\n<scr', 'ipt type="application/json">\n{"options": ["შევადაროთ", "სხვა ', 'ვარიანტები"]}\n</script>'])
  assert.equal(r.shown, '**→** შევადაროთ?')
  assert.deepEqual(r.options, ['შევადაროთ', 'სხვა ვარიანტები'])
})

test('ordinary text, including a "<" that is not a block, passes through unchanged', () => {
  const r = run(['ფასი < 60 000 ₾', ' და ', 'მეტი <'])
  assert.equal(r.shown, 'ფასი < 60 000 ₾ და მეტი <')
  assert.deepEqual(r.options, [])
})

test('a broken block is dropped without inventing options', () => {
  const r = run(['პასუხი.', '<script>{"options": [broken'])
  assert.equal(r.shown, 'პასუხი.')
  assert.deepEqual(r.options, [])
})
