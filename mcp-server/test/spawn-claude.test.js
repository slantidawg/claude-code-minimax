// test/spawn-claude.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAttempt } from '../src/spawn-claude.js'

const cfg = {
  apiKey: 'mmx-key-123',
  baseUrl: 'https://api.minimax.io/anthropic',
  model: 'MiniMax-M2.7-highspeed',
  fallbackModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
}

const baseInputs = {
  task: 'do the thing',
  cwd: '/work',
  maxTurns: 25,
  additionalDirs: [],
  cfg,
}

test('buildAttempt minimax: command and core flags', () => {
  const a = buildAttempt({ ...baseInputs, provider: 'minimax', model: 'MiniMax-M2.7-highspeed', parentEnv: {} })
  assert.equal(a.command, 'claude')
  assert.deepEqual(a.args, [
    '--print',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', '25',
    '--model', 'MiniMax-M2.7-highspeed',
    'do the thing',
  ])
  assert.equal(a.options.cwd, '/work')
})

test('buildAttempt minimax: env strips Anthropic auth, injects MMX', () => {
  const parentEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'PRIMARY-KEY',
    ANTHROPIC_AUTH_TOKEN: 'PRIMARY-TOKEN',
    CLAUDE_CODE_OAUTH_TOKEN: 'OAUTH',
    ANTHROPIC_BASE_URL: 'leftover',
  }
  const a = buildAttempt({ ...baseInputs, provider: 'minimax', model: cfg.model, parentEnv })
  assert.equal(a.options.env.PATH, '/usr/bin')
  assert.equal(a.options.env.ANTHROPIC_API_KEY, 'mmx-key-123')
  assert.equal(a.options.env.ANTHROPIC_BASE_URL, 'https://api.minimax.io/anthropic')
  assert.equal(a.options.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(a.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
})

test('buildAttempt minimax: strips CLAUDE_CODE_API_KEY_HELPER', () => {
  const parentEnv = {
    PATH: '/usr/bin',
    CLAUDE_CODE_API_KEY_HELPER: '/usr/local/bin/my-key-vendor',
  }
  const a = buildAttempt({ ...baseInputs, provider: 'minimax', model: cfg.model, parentEnv })
  assert.equal(a.options.env.CLAUDE_CODE_API_KEY_HELPER, undefined)
  assert.equal(a.options.env.PATH, '/usr/bin')
})

test('buildAttempt anthropic: env preserves parent auth, no override', () => {
  const parentEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'PRIMARY-KEY',
    CLAUDE_CODE_OAUTH_TOKEN: 'OAUTH',
  }
  const a = buildAttempt({ ...baseInputs, provider: 'anthropic', model: 'claude-sonnet-4-6', parentEnv })
  assert.equal(a.options.env.ANTHROPIC_API_KEY, 'PRIMARY-KEY')
  assert.equal(a.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'OAUTH')
  assert.equal(a.options.env.ANTHROPIC_BASE_URL, undefined)
})

test('buildAttempt: additional_dirs become --add-dir flags', () => {
  const a = buildAttempt({
    ...baseInputs,
    provider: 'minimax',
    model: cfg.model,
    additionalDirs: ['/extra/one', '/extra/two'],
    parentEnv: {},
  })
  const flat = a.args.join(' ')
  assert.match(flat, /--add-dir \/extra\/one --add-dir \/extra\/two do the thing$/)
})

test('buildAttempt: unknown provider throws', () => {
  assert.throws(
    () => buildAttempt({ ...baseInputs, provider: 'bogus', model: 'x', parentEnv: {} }),
    /Unknown provider/,
  )
})
