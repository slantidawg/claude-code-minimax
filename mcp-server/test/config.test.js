// test/config.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConfig } from '../src/config.js'

test('buildConfig: throws when MINIMAX_API_KEY missing', () => {
  assert.throws(() => buildConfig({}), /MINIMAX_API_KEY/)
})

test('buildConfig: throws when MINIMAX_API_KEY blank', () => {
  assert.throws(() => buildConfig({ MINIMAX_API_KEY: '   ' }), /MINIMAX_API_KEY/)
})

test('buildConfig: applies defaults when only key is set', () => {
  const cfg = buildConfig({ MINIMAX_API_KEY: 'sk-x' })
  assert.equal(cfg.apiKey, 'sk-x')
  assert.equal(cfg.baseUrl, 'https://api.minimax.io/anthropic')
  assert.equal(cfg.model, 'MiniMax-M2.7-highspeed')
  assert.deepEqual(cfg.fallbackModels, ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'])
})

test('buildConfig: overrides defaults from env', () => {
  const cfg = buildConfig({
    MINIMAX_API_KEY: 'sk-x',
    MINIMAX_BASE_URL: 'https://example/anthropic',
    MINIMAX_MODEL: 'custom-model',
    MINIMAX_FALLBACK_MODELS: 'a,b, c ',
  })
  assert.equal(cfg.baseUrl, 'https://example/anthropic')
  assert.equal(cfg.model, 'custom-model')
  assert.deepEqual(cfg.fallbackModels, ['a', 'b', 'c'])
})

test('buildConfig: trims whitespace from values', () => {
  const cfg = buildConfig({ MINIMAX_API_KEY: '  sk-x  ' })
  assert.equal(cfg.apiKey, 'sk-x')
})
