import assert from 'node:assert/strict'
import test from 'node:test'

import * as messages from '../lib/messages.js'

test('holds a split pseudo-tool tag until it can suppress the leaked channel', () => {
  assert.equal(typeof messages.createLeakedCallFilter, 'function')
  const filter = messages.createLeakedCallFilter()
  assert.equal(filter.push('正文'), '正文')
  assert.equal(filter.push('<antml'), '')
  assert.equal(filter.push(':inv'), '')
  assert.equal(filter.push('oke name="pwsh">secret'), '')
  assert.equal(filter.suppressed, true)
  assert.equal(filter.push('more leaked arguments'), '')
  assert.equal(filter.flush(), '')
})

const pseudoTags = [
  '<invoke>',
  '</invoke>',
  '<antml:invoke name="pwsh">',
  '</antml:invoke>',
  '<parameter name="command">',
  '</parameter>',
  '<antml:parameter name="command">',
  '</antml:parameter>',
  '<function_calls>',
  '</function_calls>',
  '<antml:function_calls>',
  '</antml:function_calls>',
]

test('never emits any part of supported pseudo-tool tags across every two-chunk split', () => {
  for (const tag of pseudoTags) {
    for (let split = 0; split <= tag.length; split += 1) {
      const filter = messages.createLeakedCallFilter()
      assert.equal(filter.push(`safe ${tag.slice(0, split)}`), 'safe ', `${tag} split ${split}`)
      assert.equal(filter.push(`${tag.slice(split)}leaked arguments`), '', `${tag} split ${split}`)
      assert.equal(filter.suppressed, true, `${tag} split ${split}`)
      assert.equal(filter.push('trailing leaked text'), '')
      assert.equal(filter.flush(), '')
    }
  }
})

test('recognizes supported tags one character at a time', () => {
  for (const tag of pseudoTags) {
    const filter = messages.createLeakedCallFilter()
    assert.equal(filter.push('safe '), 'safe ')
    for (const character of tag) assert.equal(filter.push(character), '', tag)
    assert.equal(filter.suppressed, true, tag)
    assert.equal(filter.flush(), '')
  }
})

test('preserves ordinary words, HTML, comparisons, and tag names without a word boundary', () => {
  const ordinaryText = [
    'function_calls invoke parameter antml:invoke',
    '1 < 2 and 3 > 2',
    '<div><a href="url">link</a></div>',
    '<invoked>answer</invoked>',
    '<invoke_tool name="x">answer</invoke_tool>',
    '<parameterized>answer</parameterized>',
    '<function_calls2>answer</function_calls2>',
    '<antml:invoke_more>answer</antml:invoke_more>',
    '<antml:unknown>answer</antml:unknown>',
    '<Antml:invoke>case-sensitive</Antml:invoke>',
    '< invoke>spaced</ invoke>',
    'trailing <unrelated',
  ]
  for (const text of ordinaryText) {
    for (let split = 0; split <= text.length; split += 1) {
      const filter = messages.createLeakedCallFilter()
      const output = filter.push(text.slice(0, split)) + filter.push(text.slice(split)) + filter.flush()
      assert.equal(output, text, `${text} split ${split}`)
      assert.equal(filter.suppressed, false, `${text} split ${split}`)
    }
  }
})

test('waits for a word boundary before treating a complete tag name as a leak', () => {
  const filter = messages.createLeakedCallFilter()
  assert.equal(filter.push('safe <invoke'), 'safe ')
  assert.equal(filter.suppressed, false)
  assert.equal(filter.push('_tool>answer'), '<invoke_tool>answer')
  assert.equal(filter.flush(), '')
  assert.equal(filter.suppressed, false)
})

test('matches a pseudo-tool name at any non-word boundary without waiting for the closing bracket', () => {
  for (const suffix of [' ', '\n', '/', ':', '-', '>']) {
    const filter = messages.createLeakedCallFilter()
    assert.equal(filter.push(`safe <invoke${suffix}secret`), 'safe ')
    assert.equal(filter.suppressed, true, suffix)
    assert.equal(filter.flush(), '')
  }
})

test('drops incomplete possible pseudo-tool tags at EOF without leaking their prefixes', () => {
  for (const tag of ['<invoke', '</invoke', '<antml:invoke', '</antml:invoke', '<parameter', '</parameter', '<antml:parameter', '</antml:parameter', '<function_calls', '</function_calls', '<antml:function_calls', '</antml:function_calls']) {
    for (let length = tag.startsWith('</') ? 3 : 2; length <= tag.length; length += 1) {
      const prefix = tag.slice(0, length)
      const filter = messages.createLeakedCallFilter()
      assert.equal(filter.push(`safe ${prefix}`), 'safe ', prefix)
      assert.equal(filter.suppressed, false, prefix)
      assert.equal(filter.flush(), '', prefix)
      assert.equal(filter.suppressed, true, prefix)
      assert.equal(filter.flush(), '', prefix)
    }
  }
})

test('flushes ambiguous less-than punctuation at a clean EOF exactly once', () => {
  for (const text of ['ordinary <', 'ordinary </']) {
    const filter = messages.createLeakedCallFilter()
    assert.equal(filter.push(text), 'ordinary ')
    assert.equal(filter.flush(), text.slice('ordinary '.length))
    assert.equal(filter.flush(), '')
    assert.equal(filter.suppressed, false)
  }
})

test('releases a rejected prefix promptly and preserves the next independent candidate', () => {
  const filter = messages.createLeakedCallFilter()
  assert.equal(filter.push('safe <antml:'), 'safe ')
  assert.equal(filter.push('unknown>ordinary<antml:in'), '<antml:unknown>ordinary')
  assert.equal(filter.push('voke>secret'), '')
  assert.equal(filter.suppressed, true)
})

test('emits ordinary chunks immediately and keeps suppression local to one channel', () => {
  const textFilter = messages.createLeakedCallFilter()
  const reasoningFilter = messages.createLeakedCallFilter()
  const longOrdinaryText = 'ordinary '.repeat(10000)
  assert.equal(textFilter.push(longOrdinaryText), longOrdinaryText)
  assert.equal(textFilter.push('final safe <invoke>secret'), 'final safe ')
  assert.equal(reasoningFilter.push('reasoning stays visible'), 'reasoning stays visible')
  assert.equal(reasoningFilter.suppressed, false)
  assert.equal(textFilter.suppressed, true)
})
