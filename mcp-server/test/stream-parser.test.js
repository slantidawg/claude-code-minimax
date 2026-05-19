// test/stream-parser.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamParser } from '../src/stream-parser.js'

test('parser: ignores system init', () => {
  const p = createStreamParser()
  const r = p.feed(JSON.stringify({ type: 'system', subtype: 'init' }))
  assert.equal(r.kind, 'other')
})

test('parser: extracts file_path from Edit tool_use', () => {
  const p = createStreamParser()
  p.feed(JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'editing' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/a.txt' } },
    ]},
  }))
  assert.deepEqual(p.state().filesModified, ['/tmp/a.txt'])
})

test('parser: dedupes file_paths and collects from Write/NotebookEdit', () => {
  const p = createStreamParser()
  p.feed(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/a.txt' } },
  ]}}))
  p.feed(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/a.txt' } },
    { type: 'tool_use', name: 'NotebookEdit', input: { file_path: '/tmp/b.ipynb' } },
  ]}}))
  assert.deepEqual(p.state().filesModified, ['/tmp/a.txt', '/tmp/b.ipynb'])
})

test('parser: result success populates final fields', () => {
  const p = createStreamParser()
  const r = p.feed(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'all done',
    num_turns: 4,
    total_cost_usd: 0.012,
  }))
  assert.equal(r.kind, 'final')
  assert.equal(r.state.finalResponse, 'all done')
  assert.equal(r.state.turnsUsed, 4)
  assert.equal(r.state.costUsd, 0.012)
  assert.equal(r.state.stopReason, 'completed')
})

test('parser: result error_max_turns maps to max_turns', () => {
  const p = createStreamParser()
  const r = p.feed(JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    result: null,
    num_turns: 25,
  }))
  assert.equal(r.state.stopReason, 'max_turns')
})

test('parser: result error_during_execution maps to error', () => {
  const p = createStreamParser()
  const r = p.feed(JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    result: null,
  }))
  assert.equal(r.state.stopReason, 'error')
})

test('parser: malformed JSON returns null without throwing', () => {
  const p = createStreamParser()
  const r = p.feed('not json {{{')
  assert.equal(r, null)
})
