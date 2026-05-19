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

    onProgress({ kind: 'engine_end', model: step.model, stop_reason: r.stop_reason, duration_ms })

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
    if (r.stop_reason === 'timeout') {
      if (timedOutOnce) break  // only one fallback after a timeout
      timedOutOnce = true
    }
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
      if (buffer.trim()) parser.feed(buffer.trim())
      const s = parser.state()
      if (killed) {
        resolve({ stop_reason: 'timeout', finalResponse: s.finalResponse, turnsUsed: s.turnsUsed, costUsd: s.costUsd, filesModified: s.filesModified, errorDetail: 'killed by timeout' })
        return
      }
      if (s.stopReason) {
        resolve({ stop_reason: s.stopReason, finalResponse: s.finalResponse, turnsUsed: s.turnsUsed, costUsd: s.costUsd, filesModified: s.filesModified, errorDetail: s.errorDetail })
        return
      }
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
