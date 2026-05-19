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

test('delegate: timeout on MMX falls back ONCE to Sonnet, not further', async () => {
  // Simulate: MMX times out (real timer fires), Sonnet succeeds
  let call = 0
  function fakeSpawn(_cmd, _args, _opts) {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    const myCall = call++
    if (myCall === 0) {
      // First attempt: hang until killed by the real timer — emit exit only after kill
      proc.kill = () => { proc.emit('exit', null) }
    } else {
      // Second attempt: succeed immediately
      proc.kill = () => {}
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', result: 'sonnet-recovered', num_turns: 3 }) + '\n'))
        proc.emit('exit', 0)
      })
    }
    return proc
  }
  // timeoutSeconds: 0.01 = 10ms; real timer will call proc.kill() which emits exit
  const r = await delegateTask({ task: 't', cwd: '/x', timeoutSeconds: 0.01 }, cfg, { spawn: fakeSpawn })
  assert.equal(r.engine_used, 'claude-sonnet-4-6')
  assert.equal(r.attempts.length, 2)
  assert.equal(r.attempts[0].stop_reason, 'timeout')
})
