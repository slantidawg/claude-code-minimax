# minimax-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a user-local MCP server that delegates coding tasks from a primary Claude Code session to a subprocess Claude Code running on MiniMax (MiniMax-M2.7-highspeed via the Anthropic-compatible endpoint), with automatic fallback to `claude-sonnet-4-6` → `claude-haiku-4-5-20251001` on hard failure.

**Architecture:** Node 18 MCP server using `@modelcontextprotocol/sdk`. Exposes three tools: `delegate_task`, `cancel`, `list_models`. `delegate_task` spawns `claude --print` as a subprocess with provider-specific env per attempt, parses its stream-json output, and runs the fallback chain sequentially. The CLAUDE.md directive that makes delegation the *default* is the final task and is gated on a successful smoke test — it's NOT installed until human-verified output quality is acceptable.

**Tech Stack:** Node 18, `@modelcontextprotocol/sdk`, `dotenv`, `node:test` (built-in).

**Spec:** `~/.minimax-mcp/docs/superpowers/specs/2026-05-18-minimax-mcp-design.md`

**Working directory for all tasks:** `~/.minimax-mcp/`

---

## File structure

```
~/.minimax-mcp/
├── package.json
├── .env                                          (exists, gitignored)
├── .env.example                                  (created in Task 9)
├── .gitignore                                    (exists)
├── README.md                                     (created in Task 9)
├── src/
│   ├── server.js          — MCP server entry, tool registration, transport
│   ├── config.js          — dotenv loader + buildConfig (pure)
│   ├── spawn-claude.js    — buildAttempt: pure builder for spawn args/env
│   ├── stream-parser.js   — incremental JSON-line parser for claude stream-json
│   ├── delegate.js        — orchestrates fallback chain; spawns subprocesses
│   └── jobs.js            — in-memory job registry for cancel
├── test/
│   ├── config.test.js
│   ├── spawn-claude.test.js
│   ├── stream-parser.test.js
│   ├── delegate.test.js
│   └── smoke.test.js
└── docs/superpowers/
    ├── specs/2026-05-18-minimax-mcp-design.md     (exists)
    └── plans/2026-05-18-minimax-mcp.md            (this file)
```

Boundaries:
- `config.js` is the **only** module that touches the filesystem env.
- `spawn-claude.js` and `stream-parser.js` are **pure** (no I/O), so unit tests don't need mocks.
- `delegate.js` is the only module that spawns; it takes `spawn` as an injectable dependency so tests can substitute a fake.
- `server.js` is glue — it imports the above and registers MCP tools. No tests; covered by `smoke.test.js`.

---

## Task 1: Initialize Node project

**Files:**
- Create: `~/.minimax-mcp/package.json`

- [ ] **Step 1: Create package.json**

```bash
cat > ~/.minimax-mcp/package.json <<'EOF'
{
  "name": "minimax-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "minimax-mcp": "src/server.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "dotenv": "^16.4.5"
  },
  "engines": {
    "node": ">=18"
  }
}
EOF
```

- [ ] **Step 2: Install dependencies**

```bash
cd ~/.minimax-mcp && npm install
```

Expected: `node_modules/` populated, `package-lock.json` created, no errors.

- [ ] **Step 3: Verify Node test runner works**

```bash
cd ~/.minimax-mcp && node --test --test-name-pattern='__none__' || echo "runner ok"
```

Expected: prints `runner ok` (no tests found, but the runner ran).

- [ ] **Step 4: Commit**

```bash
cd ~/.minimax-mcp && git add package.json package-lock.json && git commit -m "chore: initialize Node project with MCP SDK + dotenv"
```

---

## Task 2: Config loader (TDD)

**Files:**
- Create: `~/.minimax-mcp/test/config.test.js`
- Create: `~/.minimax-mcp/src/config.js`

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd ~/.minimax-mcp && node --test test/config.test.js
```

Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Implement config.js**

```js
// src/config.js
import { config as loadEnv } from 'dotenv'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_ENV_PATH = join(homedir(), '.minimax-mcp', '.env')

const DEFAULTS = {
  baseUrl: 'https://api.minimax.io/anthropic',
  model: 'MiniMax-M2.7-highspeed',
  fallbackModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
}

const pick = (env, key) => (env[key] ?? '').trim()

export function buildConfig(env) {
  const apiKey = pick(env, 'MINIMAX_API_KEY')
  if (!apiKey) {
    throw new Error(`Missing required env: MINIMAX_API_KEY (expected in ${DEFAULT_ENV_PATH})`)
  }
  const fbRaw = pick(env, 'MINIMAX_FALLBACK_MODELS')
  return {
    apiKey,
    baseUrl: pick(env, 'MINIMAX_BASE_URL') || DEFAULTS.baseUrl,
    model: pick(env, 'MINIMAX_MODEL') || DEFAULTS.model,
    fallbackModels: fbRaw
      ? fbRaw.split(',').map(s => s.trim()).filter(Boolean)
      : DEFAULTS.fallbackModels,
  }
}

export function loadFromFile(path = DEFAULT_ENV_PATH) {
  loadEnv({ path, override: false })
  return buildConfig(process.env)
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd ~/.minimax-mcp && node --test test/config.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/.minimax-mcp && git add src/config.js test/config.test.js && git commit -m "feat: config loader with env defaults and validation"
```

---

## Task 3: Spawn-claude builder (TDD)

**Files:**
- Create: `~/.minimax-mcp/test/spawn-claude.test.js`
- Create: `~/.minimax-mcp/src/spawn-claude.js`

- [ ] **Step 1: Write the failing tests**

```js
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

test('buildAttempt anthropic: env preserves parent auth, no override', () => {
  const parentEnv = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'PRIMARY-KEY',
    CLAUDE_CODE_OAUTH_TOKEN: 'OAUTH',
  }
  const a = buildAttempt({ ...baseInputs, provider: 'anthropic', model: 'claude-sonnet-4-6', parentEnv })
  assert.equal(a.options.env.ANTHROPIC_API_KEY, 'PRIMARY-KEY')
  assert.equal(a.options.env.CLAUDE_CODE_OAUTH_TOKEN, 'OAUTH')
  // base URL not set means SDK default (api.anthropic.com)
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
  // sequence: ... --add-dir /extra/one --add-dir /extra/two TASK
  const flat = a.args.join(' ')
  assert.match(flat, /--add-dir \/extra\/one --add-dir \/extra\/two do the thing$/)
})

test('buildAttempt: unknown provider throws', () => {
  assert.throws(
    () => buildAttempt({ ...baseInputs, provider: 'bogus', model: 'x', parentEnv: {} }),
    /Unknown provider/,
  )
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd ~/.minimax-mcp && node --test test/spawn-claude.test.js
```

Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Implement spawn-claude.js**

```js
// src/spawn-claude.js
const STRIPPED_FOR_MMX = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

export function buildAttempt({ provider, model, task, cwd, maxTurns, additionalDirs = [], cfg, parentEnv }) {
  const args = [
    '--print',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns),
    '--model', model,
    ...additionalDirs.flatMap(d => ['--add-dir', d]),
    task,
  ]

  let env
  if (provider === 'minimax') {
    env = { ...parentEnv }
    for (const k of STRIPPED_FOR_MMX) delete env[k]
    env.ANTHROPIC_BASE_URL = cfg.baseUrl
    env.ANTHROPIC_API_KEY = cfg.apiKey
  } else if (provider === 'anthropic') {
    env = { ...parentEnv }
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }

  return { command: 'claude', args, options: { cwd, env } }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd ~/.minimax-mcp && node --test test/spawn-claude.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/.minimax-mcp && git add src/spawn-claude.js test/spawn-claude.test.js && git commit -m "feat: spawn-claude builder with per-provider env hygiene"
```

---

## Task 4: Stream-json parser (TDD)

**Files:**
- Create: `~/.minimax-mcp/test/stream-parser.test.js`
- Create: `~/.minimax-mcp/src/stream-parser.js`

Background: `claude --output-format stream-json` emits one JSON object per line. Event shapes we care about:

- `{ "type": "system", "subtype": "init", ... }` — ignore
- `{ "type": "assistant", "message": { "content": [...] } }` — content blocks may include `{ "type": "tool_use", "name": "Edit", "input": { "file_path": "..." } }`
- `{ "type": "user", "message": ... }` — tool_result echoes; ignore
- `{ "type": "result", "subtype": "success" | "error_max_turns" | "error_during_execution", "result": "...", "num_turns": 3, "total_cost_usd": 0.01 }` — the final event

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd ~/.minimax-mcp && node --test test/stream-parser.test.js
```

Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Implement stream-parser.js**

```js
// src/stream-parser.js
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

const SUBTYPE_TO_STOP = {
  success: 'completed',
  error_max_turns: 'max_turns',
  error_during_execution: 'error',
}

export function createStreamParser() {
  const state = {
    finalResponse: null,
    turnsUsed: 0,
    costUsd: null,
    filesModified: [],
    stopReason: null,
    errorDetail: null,
  }

  function feed(line) {
    let obj
    try { obj = JSON.parse(line) } catch { return null }

    if (obj.type === 'result') {
      state.finalResponse = obj.result ?? null
      state.turnsUsed = obj.num_turns ?? 0
      state.costUsd = obj.total_cost_usd ?? null
      state.stopReason = SUBTYPE_TO_STOP[obj.subtype] ?? 'error'
      if (state.stopReason === 'error') state.errorDetail = obj.subtype || 'unknown'
      return { kind: 'final', state: { ...state, filesModified: [...state.filesModified] } }
    }

    if (obj.type === 'assistant') {
      const content = obj.message?.content ?? []
      for (const block of content) {
        if (block.type === 'tool_use' && EDIT_TOOLS.has(block.name)) {
          const fp = block.input?.file_path
          if (fp && !state.filesModified.includes(fp)) {
            state.filesModified.push(fp)
          }
        }
      }
      return { kind: 'progress', message: obj.message }
    }

    return { kind: 'other', obj }
  }

  return { feed, state: () => ({ ...state, filesModified: [...state.filesModified] }) }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd ~/.minimax-mcp && node --test test/stream-parser.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/.minimax-mcp && git add src/stream-parser.js test/stream-parser.test.js && git commit -m "feat: stream-json parser tracks files, turns, cost, stop reason"
```

---

## Task 5: Jobs registry

**Files:**
- Create: `~/.minimax-mcp/src/jobs.js`

Stateful module, tiny. Test by hand-running the cancel path during smoke test rather than mocking timers here.

- [ ] **Step 1: Implement jobs.js**

```js
// src/jobs.js
let nextId = 1
const jobs = new Map()

export function register(proc) {
  const id = String(nextId++)
  jobs.set(id, proc)
  proc.once('exit', () => jobs.delete(id))
  return id
}

export function cancel(id) {
  const proc = jobs.get(id)
  if (!proc) return false
  proc.kill('SIGTERM')
  setTimeout(() => {
    if (jobs.has(id)) proc.kill('SIGKILL')
  }, 5000).unref()
  return true
}

export function list() {
  return [...jobs.keys()]
}

export function reset() {
  jobs.clear()
  nextId = 1
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/.minimax-mcp && git add src/jobs.js && git commit -m "feat: in-memory job registry with SIGTERM/SIGKILL cancel"
```

---

## Task 6: Delegate orchestration (TDD with fake spawn)

**Files:**
- Create: `~/.minimax-mcp/test/delegate.test.js`
- Create: `~/.minimax-mcp/src/delegate.js`

`delegate.js` is the orchestrator. To keep it testable, it accepts `spawn` as an injectable option (defaults to `node:child_process.spawn`). Tests pass a fake that returns a controllable mock process.

- [ ] **Step 1: Write the failing tests**

```js
// test/delegate.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { delegateTask } from '../src/delegate.js'

function makeFakeSpawn(plan) {
  // plan: array of { stdoutLines, exitCode } in order of calls
  let call = 0
  return function fakeSpawn(_cmd, _args, _opts) {
    const step = plan[call++]
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    setImmediate(() => {
      for (const line of step.stdoutLines) {
        proc.stdout.emit('data', Buffer.from(line + '\n'))
      }
      proc.emit('exit', step.exitCode ?? 0)
    })
    return proc
  }
}

const cfg = {
  apiKey: 'k',
  baseUrl: 'https://api.minimax.io/anthropic',
  model: 'MiniMax-M2.7-highspeed',
  fallbackModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
}

test('delegate: MMX succeeds first try', async () => {
  const spawn = makeFakeSpawn([{
    stdoutLines: [
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', num_turns: 2, total_cost_usd: 0.001 }),
    ],
  }])
  const r = await delegateTask({ task: 't', cwd: '/x' }, cfg, { spawn })
  assert.equal(r.stop_reason, 'completed')
  assert.equal(r.engine_used, 'MiniMax-M2.7-highspeed')
  assert.equal(r.final_response, 'done')
  assert.equal(r.attempts.length, 1)
})

test('delegate: MMX fails, falls back to Sonnet which succeeds', async () => {
  const spawn = makeFakeSpawn([
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution' })] },
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'success', result: 'sonnet-done', num_turns: 3 })] },
  ])
  const r = await delegateTask({ task: 't', cwd: '/x' }, cfg, { spawn })
  assert.equal(r.engine_used, 'claude-sonnet-4-6')
  assert.equal(r.final_response, 'sonnet-done')
  assert.equal(r.attempts.length, 2)
  assert.equal(r.attempts[0].model, 'MiniMax-M2.7-highspeed')
  assert.equal(r.attempts[0].stop_reason, 'error')
})

test('delegate: all engines fail returns all_engines_failed', async () => {
  const spawn = makeFakeSpawn([
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution' })] },
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution' })] },
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution' })] },
  ])
  const r = await delegateTask({ task: 't', cwd: '/x' }, cfg, { spawn })
  assert.equal(r.stop_reason, 'all_engines_failed')
  assert.equal(r.engine_used, null)
  assert.equal(r.final_response, null)
  assert.equal(r.attempts.length, 3)
})

test('delegate: max_turns does NOT trigger fallback', async () => {
  const spawn = makeFakeSpawn([{
    stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_max_turns', num_turns: 25 })],
  }])
  const r = await delegateTask({ task: 't', cwd: '/x' }, cfg, { spawn })
  assert.equal(r.stop_reason, 'max_turns')
  assert.equal(r.engine_used, 'MiniMax-M2.7-highspeed')
  assert.equal(r.attempts.length, 1)
})

test('delegate: fallback=false stops after MMX failure', async () => {
  const spawn = makeFakeSpawn([
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution' })] },
  ])
  const r = await delegateTask({ task: 't', cwd: '/x', fallback: false }, cfg, { spawn })
  assert.equal(r.stop_reason, 'all_engines_failed')
  assert.equal(r.attempts.length, 1)
})

test('delegate: subprocess crash (non-zero exit, no result line) treated as error', async () => {
  const spawn = makeFakeSpawn([
    { stdoutLines: [], exitCode: 1 },
    { stdoutLines: [JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })] },
  ])
  const r = await delegateTask({ task: 't', cwd: '/x' }, cfg, { spawn })
  assert.equal(r.engine_used, 'claude-sonnet-4-6')
  assert.equal(r.attempts[0].stop_reason, 'error')
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd ~/.minimax-mcp && node --test test/delegate.test.js
```

Expected: FAIL — `Cannot find module`.

- [ ] **Step 3: Implement delegate.js**

```js
// src/delegate.js
import { spawn as nodeSpawn } from 'node:child_process'
import { buildAttempt } from './spawn-claude.js'
import { createStreamParser } from './stream-parser.js'
import * as jobs from './jobs.js'

export async function delegateTask(input, cfg, opts = {}) {
  const {
    task,
    cwd = process.cwd(),
    maxTurns = 25,
    timeoutSeconds = 600,
    totalTimeoutSeconds = 1800,
    model,
    additionalDirs = [],
    fallback = true,
  } = input

  const spawn = opts.spawn || nodeSpawn
  const onProgress = opts.onProgress || (() => {})
  const parentEnv = opts.parentEnv || process.env

  const chain = [{ provider: 'minimax', model: model || cfg.model }]
  if (fallback) {
    for (const m of cfg.fallbackModels) chain.push({ provider: 'anthropic', model: m })
  }

  const startedAt = Date.now()
  const attempts = []
  let timedOutOnce = false

  for (const step of chain) {
    const elapsed = Date.now() - startedAt
    if (elapsed > totalTimeoutSeconds * 1000) {
      return finalize({ stop_reason: 'timeout', engine_used: null, attempts, startedAt })
    }
    if (timedOutOnce) break  // one-step fallback on timeout only

    onProgress({ kind: 'engine_start', model: step.model })
    const built = buildAttempt({
      provider: step.provider,
      model: step.model,
      task, cwd, maxTurns, additionalDirs, cfg, parentEnv,
    })

    const attemptStart = Date.now()
    const r = await runSubprocess(spawn, built, timeoutSeconds, onProgress)
    const duration_ms = Date.now() - attemptStart

    attempts.push({
      model: step.model,
      stop_reason: r.stop_reason,
      duration_ms,
      error: r.errorDetail ?? null,
    })

    if (r.stop_reason === 'completed') {
      return {
        stop_reason: 'completed',
        engine_used: step.model,
        final_response: r.finalResponse,
        attempts,
        turns_used: r.turnsUsed,
        duration_ms,
        cost_usd: r.costUsd,
        files_modified: r.filesModified,
      }
    }
    if (r.stop_reason === 'max_turns') {
      return {
        stop_reason: 'max_turns',
        engine_used: step.model,
        final_response: r.finalResponse,
        attempts,
        turns_used: r.turnsUsed,
        duration_ms,
        cost_usd: r.costUsd,
        files_modified: r.filesModified,
      }
    }
    if (r.stop_reason === 'timeout') timedOutOnce = true
    // else 'error' — continue to next attempt
  }

  return finalize({ stop_reason: 'all_engines_failed', engine_used: null, attempts, startedAt })
}

function finalize({ stop_reason, engine_used, attempts, startedAt }) {
  return {
    stop_reason,
    engine_used,
    final_response: null,
    attempts,
    turns_used: 0,
    duration_ms: Date.now() - startedAt,
    cost_usd: null,
    files_modified: [],
  }
}

function runSubprocess(spawn, built, timeoutSeconds, onProgress) {
  return new Promise(resolve => {
    const proc = spawn(built.command, built.args, built.options)
    jobs.register(proc)
    const parser = createStreamParser()
    let stderr = ''
    let buffer = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000).unref()
    }, timeoutSeconds * 1000)

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        const evt = parser.feed(line)
        if (evt && evt.kind === 'progress') onProgress({ kind: 'subprocess', message: evt.message })
      }
    })
    proc.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    proc.on('error', err => {
      clearTimeout(timer)
      resolve({ stop_reason: 'error', errorDetail: err.message, finalResponse: null, turnsUsed: 0, costUsd: null, filesModified: [] })
    })
    proc.on('exit', code => {
      clearTimeout(timer)
      const s = parser.state()
      if (killed) {
        resolve({ stop_reason: 'timeout', finalResponse: s.finalResponse, turnsUsed: s.turnsUsed, costUsd: s.costUsd, filesModified: s.filesModified, errorDetail: 'killed by timeout' })
        return
      }
      if (s.stopReason) {
        resolve({ stop_reason: s.stopReason, finalResponse: s.finalResponse, turnsUsed: s.turnsUsed, costUsd: s.costUsd, filesModified: s.filesModified, errorDetail: s.errorDetail })
        return
      }
      // No result line — subprocess exited without completing
      resolve({
        stop_reason: 'error',
        errorDetail: stderr.slice(-500) || `exit ${code}`,
        finalResponse: null,
        turnsUsed: 0,
        costUsd: null,
        filesModified: s.filesModified,
      })
    })
  })
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd ~/.minimax-mcp && node --test test/delegate.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/.minimax-mcp && git add src/delegate.js test/delegate.test.js && git commit -m "feat: delegate orchestration with fallback chain"
```

---

## Task 7: MCP server entry

**Files:**
- Create: `~/.minimax-mcp/src/server.js`

- [ ] **Step 1: Implement server.js**

```js
#!/usr/bin/env node
// src/server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { loadFromFile } from './config.js'
import { delegateTask } from './delegate.js'
import * as jobs from './jobs.js'

const cfg = loadFromFile()

const server = new Server(
  { name: 'minimax-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

const TOOLS = [
  {
    name: 'delegate_task',
    description:
      'Delegate a scoped coding task to a subprocess Claude Code running on MiniMax-M2.7-highspeed, with auto-fallback to claude-sonnet-4-6 then claude-haiku-4-5-20251001 on hard failure. The worker has no visibility into the caller\'s conversation, so `task` must be self-contained.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'Self-contained task. Include file paths, acceptance criteria, and any non-obvious constraints.',
        },
        cwd: { type: 'string', description: 'Working directory. Defaults to caller cwd.' },
        timeout_seconds: { type: 'number', default: 600 },
        total_timeout_seconds: { type: 'number', default: 1800 },
        max_turns: { type: 'number', default: 25 },
        model: { type: 'string', description: 'Override the primary model. Fallback chain still applies unless fallback=false.' },
        fallback: { type: 'boolean', default: true, description: 'Set false to disable auto-fallback (MMX only).' },
        additional_dirs: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'cancel',
    description: 'Cancel a running delegate_task job by id.',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: { job_id: { type: 'string' } },
    },
  },
  {
    name: 'list_models',
    description: 'List the configured default model and the fallback chain.',
    inputSchema: { type: 'object', properties: {} },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  if (name === 'delegate_task') {
    const result = await delegateTask(
      {
        task: args.task,
        cwd: args.cwd,
        timeoutSeconds: args.timeout_seconds,
        totalTimeoutSeconds: args.total_timeout_seconds,
        maxTurns: args.max_turns,
        model: args.model,
        fallback: args.fallback,
        additionalDirs: args.additional_dirs,
      },
      cfg,
      {},
    )
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
  if (name === 'cancel') {
    const ok = jobs.cancel(String(args.job_id))
    return { content: [{ type: 'text', text: JSON.stringify({ cancelled: ok }) }] }
  }
  if (name === 'list_models') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ default: cfg.model, fallbacks: cfg.fallbackModels }, null, 2),
      }],
    }
  }
  throw new Error(`Unknown tool: ${name}`)
})

await server.connect(new StdioServerTransport())
```

- [ ] **Step 2: Make executable**

```bash
chmod +x ~/.minimax-mcp/src/server.js
```

- [ ] **Step 3: Sanity-launch the server (kill after 2s)**

```bash
cd ~/.minimax-mcp && timeout 2 node src/server.js < /dev/null; echo "exit=$?"
```

Expected: exits with code 124 (timeout's signal) or 143 (SIGTERM), with no Node errors before. If you see `Missing required env: MINIMAX_API_KEY`, your `.env` isn't being read — verify with `cat -A ~/.minimax-mcp/.env`.

- [ ] **Step 4: Commit**

```bash
cd ~/.minimax-mcp && git add src/server.js && git commit -m "feat: MCP server entry registering delegate_task, cancel, list_models"
```

---

## Task 8: Wiring smoke test (scripted)

**Files:**
- Create: `~/.minimax-mcp/test/smoke.test.js`

Verifies the server starts, lists tools over stdio, and responds to `list_models` — no live MMX call.

- [ ] **Step 1: Write the test**

```js
// test/smoke.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, '..', 'src', 'server.js')

function rpc(proc, message) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx >= 0) {
        const line = buffer.slice(0, idx)
        proc.stdout.off('data', onData)
        try { resolve(JSON.parse(line)) } catch (e) { reject(e) }
      }
    }
    proc.stdout.on('data', onData)
    proc.stdin.write(JSON.stringify(message) + '\n')
    setTimeout(() => { proc.stdout.off('data', onData); reject(new Error('rpc timeout')) }, 5000)
  })
}

test('server lists three tools', async () => {
  const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    const initResp = await rpc(proc, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    })
    assert.equal(initResp.id, 1)
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

    const listResp = await rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const names = listResp.result.tools.map(t => t.name).sort()
    assert.deepEqual(names, ['cancel', 'delegate_task', 'list_models'])

    const lm = await rpc(proc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_models', arguments: {} } })
    const payload = JSON.parse(lm.result.content[0].text)
    assert.equal(payload.default, 'MiniMax-M2.7-highspeed')
    assert.deepEqual(payload.fallbacks, ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'])
  } finally {
    proc.kill('SIGTERM')
  }
})
```

- [ ] **Step 2: Run all tests**

```bash
cd ~/.minimax-mcp && node --test test/*.test.js
```

Expected: ALL PASS. Total: ~19 tests across 5 files.

- [ ] **Step 3: Commit**

```bash
cd ~/.minimax-mcp && git add test/smoke.test.js && git commit -m "test: wiring smoke (server lists tools, list_models works)"
```

---

## Task 9: README and .env.example

**Files:**
- Create: `~/.minimax-mcp/README.md`
- Create: `~/.minimax-mcp/.env.example`

- [ ] **Step 1: Write .env.example**

```bash
cat > ~/.minimax-mcp/.env.example <<'EOF'
# Copy this file to .env and fill in your key. chmod 600 .env after writing.
MINIMAX_API_KEY=
MINIMAX_BASE_URL=https://api.minimax.io/anthropic
MINIMAX_MODEL=MiniMax-M2.7-highspeed
# Optional: comma-separated fallback chain (default: claude-sonnet-4-6,claude-haiku-4-5-20251001)
# MINIMAX_FALLBACK_MODELS=claude-sonnet-4-6,claude-haiku-4-5-20251001
EOF
```

- [ ] **Step 2: Write README.md**

```bash
cat > ~/.minimax-mcp/README.md <<'EOF'
# minimax-mcp

A user-local MCP server that lets a primary Claude Code session delegate scoped coding tasks to a subprocess Claude Code running on MiniMax-M2.7-highspeed (via the Anthropic-compatible endpoint), with automatic fallback to Sonnet → Haiku on hard failure.

## Setup

1. Install:
   ```
   cd ~/.minimax-mcp && npm install
   ```

2. Create `.env`:
   ```
   cp .env.example .env
   chmod 600 .env
   ```
   Edit `.env` and paste your MiniMax API key.

3. Register in `~/.claude/settings.json`:
   ```json
   {
     "mcpServers": {
       "minimax": {
         "command": "node",
         "args": ["/home/colin/.minimax-mcp/src/server.js"]
       }
     },
     "permissions": {
       "allow": [
         "mcp__minimax__delegate_task",
         "mcp__minimax__cancel",
         "mcp__minimax__list_models"
       ]
     }
   }
   ```

4. Start a new Claude Code session. Verify tools are available:
   ```
   /mcp
   ```
   You should see `minimax` listed with three tools.

## Tools

- **`delegate_task`** — hand a self-contained coding task to a subprocess Claude Code. Returns `final_response`, `engine_used`, `attempts[]`, `files_modified[]`.
- **`cancel`** — terminate a running job by id.
- **`list_models`** — show the configured default and fallback chain.

## Spec

`docs/superpowers/specs/2026-05-18-minimax-mcp-design.md`

## Tests

```
npm test
```
EOF
```

- [ ] **Step 3: Commit**

```bash
cd ~/.minimax-mcp && git add README.md .env.example && git commit -m "docs: README and .env.example"
```

---

## Task 10: Register MCP server in ~/.claude/settings.json

**Files:**
- Modify: `~/.claude/settings.json`

⚠️ **Important:** Do NOT overwrite `~/.claude/settings.json`. The user has existing hooks and configuration in it. Use a careful merge.

- [ ] **Step 1: Back up current settings**

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%Y%m%d%H%M%S)
```

- [ ] **Step 2: Inspect the current shape**

```bash
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/settings.json','utf8')), null, 2))" | head -80
```

Note whether `mcpServers` and `permissions.allow` already exist. If they do, merge into them; do not replace.

- [ ] **Step 3: Merge the minimax entry**

```bash
node -e '
const fs = require("fs");
const os = require("os");
const p = os.homedir() + "/.claude/settings.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
s.mcpServers = s.mcpServers || {};
s.mcpServers.minimax = {
  command: "node",
  args: [os.homedir() + "/.minimax-mcp/src/server.js"],
};
s.permissions = s.permissions || {};
s.permissions.allow = s.permissions.allow || [];
for (const t of ["mcp__minimax__delegate_task", "mcp__minimax__cancel", "mcp__minimax__list_models"]) {
  if (!s.permissions.allow.includes(t)) s.permissions.allow.push(t);
}
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
console.log("merged");
'
```

Expected: prints `merged`.

- [ ] **Step 4: Verify the merge**

```bash
node -e "const s = require(require('os').homedir()+'/.claude/settings.json'); console.log(JSON.stringify({mcpServers: s.mcpServers, allow: s.permissions && s.permissions.allow}, null, 2))"
```

Expected: shows the `minimax` entry under `mcpServers` and the three permission entries under `permissions.allow`. **Confirm pre-existing hooks/keys are still present** by diffing against the backup:

```bash
diff <(cat ~/.claude/settings.json.bak.* | sort -u | head -1 | python3 -c "import sys,json; print(json.dumps(json.loads(sys.stdin.read()), indent=2, sort_keys=True))") <(python3 -c "import json,os; print(json.dumps(json.load(open(os.path.expanduser('~/.claude/settings.json'))), indent=2, sort_keys=True))") | head -40
```

You should see only additions (new `mcpServers.minimax` and three new permission entries), no deletions.

- [ ] **Step 5: Tell the user to restart**

User must start a fresh Claude Code session for the new MCP server to load. The current session will not see it.

---

## Task 11: Manual smoke #1 — list_models

**Performed by the user in a fresh Claude Code session.**

- [ ] **Step 1: Start a fresh session**

The user opens a new Claude Code session.

- [ ] **Step 2: Verify the server is loaded**

User runs `/mcp` and confirms `minimax` shows as connected with three tools.

- [ ] **Step 3: Call list_models**

User asks the assistant to invoke `mcp__minimax__list_models`. Expected response:
```json
{ "default": "MiniMax-M2.7-highspeed", "fallbacks": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"] }
```

- [ ] **Step 4: If it fails, diagnose**

- "Tool not found" → server isn't registered or session wasn't restarted.
- "Missing required env" → `.env` isn't readable; re-check path and 0600 perms.
- "Cannot find module" → `npm install` wasn't run in `~/.minimax-mcp`.

---

## Task 12: Manual smoke #2 — trivial delegate_task

**Performed by the user in the same fresh session.**

- [ ] **Step 1: Pre-clear the test path**

```bash
rm -rf /tmp/minimax-smoke && mkdir -p /tmp/minimax-smoke
```

- [ ] **Step 2: Invoke delegate_task**

User asks the assistant to invoke:
```json
{
  "name": "mcp__minimax__delegate_task",
  "arguments": {
    "task": "Create the file /tmp/minimax-smoke/hello.txt containing exactly the single line: PONG\nThen stop.",
    "cwd": "/tmp/minimax-smoke",
    "max_turns": 5,
    "timeout_seconds": 120
  }
}
```

- [ ] **Step 3: Verify the file**

```bash
cat /tmp/minimax-smoke/hello.txt
```

Expected: `PONG` (one line).

- [ ] **Step 4: Inspect the tool response**

Confirm:
- `engine_used` is `MiniMax-M2.7-highspeed` (or one of the fallbacks if MMX failed)
- `attempts[]` length is 1 if MMX succeeded, otherwise shows the failure(s)
- `files_modified` includes `/tmp/minimax-smoke/hello.txt`
- `stop_reason` is `completed`

- [ ] **Step 5: Re-run with fallback disabled to force MMX-only**

```json
{
  "name": "mcp__minimax__delegate_task",
  "arguments": {
    "task": "Create /tmp/minimax-smoke/two.txt containing: TWO",
    "cwd": "/tmp/minimax-smoke",
    "max_turns": 5,
    "timeout_seconds": 120,
    "fallback": false
  }
}
```

If MMX is healthy this succeeds with `engine_used: MiniMax-M2.7-highspeed`. If not, you'll see `stop_reason: all_engines_failed` — useful diagnostic.

---

## Task 13: QUALITY GATE — is the smoke output acceptable?

This is a human-judgment gate, not a coded check. Before proceeding to Task 14, answer:

1. Did `delegate_task` actually create the files in Tasks 12.2 and 12.5?
2. Was `engine_used: MiniMax-M2.7-highspeed` on at least one of the calls (i.e., MMX isn't silently failing every time)?
3. Did the subprocess complete within reasonable time (under 60s for a trivial file-write task)?
4. Is the cost (per `cost_usd` and your MMX dashboard) actually lower than equivalent Sonnet work would have been?

**If all yes → proceed to Task 14.**

**If any no → stop and decide:**
- MMX quality bad? Try a different MMX model (`MINIMAX_MODEL` in `.env`); re-run Task 12.
- MMX never selected? Inspect `attempts[]` for the failure reason; it may be auth, base URL, or model name.
- Too slow? Tighten `max_turns` / `timeout_seconds` defaults in `server.js`.

Loop until acceptable. The CLAUDE.md directive in Task 14 should not be installed against a broken tool.

---

## Task 14: Install the CLAUDE.md directive (gated on Task 13)

**Files:**
- Modify: `~/.claude/CLAUDE.md`

This is the change that makes delegation the *default* for future sessions. Only run this task after Task 13 passes.

- [ ] **Step 1: Back up CLAUDE.md**

```bash
cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak.$(date +%Y%m%d%H%M%S)
```

- [ ] **Step 2: Append the directive**

```bash
cat >> ~/.claude/CLAUDE.md <<'EOF'

## MiniMax delegation default

For well-scoped coding tasks (writing/editing files, implementing functions, running tests, refactoring) default to `mcp__minimax__delegate_task` instead of doing the work locally. The MCP runs MiniMax-M2.7-highspeed with auto-fallback to Sonnet → Haiku.

Don't delegate when:
- The task hinges on this session's conversation context that can't be summarized into a self-contained `task` string
- Inline is faster (one-line edit, single grep, single file Read)
- It's orchestration itself (planning, reviewing delegated output, deciding what to delegate next)

Always include in the `task` argument: the cwd-relative file paths involved, the acceptance criteria, any non-obvious constraints. The worker has no view of this session.

After a delegate_task call, inspect `engine_used`. If it's not `MiniMax-M2.7-highspeed`, MMX was bypassed via fallback — note it to the user; repeated MMX failures may need investigation.
EOF
```

- [ ] **Step 3: Verify the append**

```bash
tail -25 ~/.claude/CLAUDE.md
```

Expected: shows the new section ending with "...may need investigation."

- [ ] **Step 4: Reload in a new session**

User opens a fresh Claude Code session and gives any normal coding task ("rename function X in file Y"). Confirm primary reaches for `mcp__minimax__delegate_task` without being asked.

If primary doesn't delegate, re-read the directive — phrasing may need tightening based on observed behavior. Iterate.

- [ ] **Step 5 (optional): Commit the directive separately if you keep CLAUDE.md in version control**

Not applicable in this user's setup (CLAUDE.md is not in a repo). Skip.

---

## Done

After Task 14, `mcp__minimax__delegate_task` is wired, smoke-tested, and is the default execution path for new Claude Code sessions. Sonnet credit is conserved by routing coding work through MiniMax first.

Operating notes:
- Watch `engine_used` in delegated responses. A steady stream of `claude-sonnet-4-6` outcomes means MMX is failing — investigate.
- Watch `attempts[]` for slow chains (multiple seconds wasted on a failing MMX before falling back). May warrant tightening `timeout_seconds` defaults or disabling MMX temporarily by editing `.env`.
- If you ever want to revert the default-delegation behavior, remove the "MiniMax delegation default" section from `~/.claude/CLAUDE.md`. The MCP server stays available; primary just stops reaching for it automatically.
