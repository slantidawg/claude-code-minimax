#!/usr/bin/env node
// src/server.js
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { loadFromFile } from './config.js'
import { delegateTask } from './delegate.js'
import { createLogger, nextJobId } from './logger.js'

const cfg = loadFromFile()
const logger = createLogger()

const BRIEFING_PATHS = ['MMX_BRIEFING.md', 'docs/MMX_BRIEFING.md']

async function loadBriefing(cwd) {
  if (!cwd || !isAbsolute(cwd)) return null
  for (const rel of BRIEFING_PATHS) {
    const full = join(cwd, rel)
    if (existsSync(full)) {
      try {
        const content = await readFile(full, 'utf8')
        if (content.trim()) return { path: full, content }
      } catch {}
    }
  }
  return null
}

const STALE_CONTEXT_PATTERNS = [
  /\byour previous\b/i,
  /\byou (?:already|earlier|before|previously)\b/i,
  /\bas (?:you|i) (?:did|said|wrote)\b/i,
  /\b(?:the|that) (?:bug|fix|change|refactor) from (?:last time|before|earlier)\b/i,
  /\bcontinue (?:from )?(?:where|the) (?:we|you) left off\b/i,
  /\b(?:earlier|previously) in (?:this|our) (?:session|conversation)\b/i,
]

function detectStaleContextHints(taskText) {
  if (typeof taskText !== 'string') return []
  const hits = []
  for (const pat of STALE_CONTEXT_PATTERNS) {
    const m = taskText.match(pat)
    if (m) hits.push(m[0])
  }
  return hits
}

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
      required: ['task', 'acceptance_commands'],
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
        acceptance_commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Shell commands the worker must run to verify its work passes. REQUIRED to force callers to think about verification before delegating. Example: ["pytest tests/foo.py", "tsc --noEmit"]. If verification is truly impossible (e.g., docs-only edit), pass [] and state why in the task arg.',
        },
        skip_briefing: { type: 'boolean', default: false, description: 'Skip auto-prepending docs/MMX_BRIEFING.md (or MMX_BRIEFING.md) if it exists in cwd.' },
      },
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
    if (!Array.isArray(args.acceptance_commands)) {
      throw new Error("acceptance_commands is required: provide an array of shell commands (use [] with rationale in `task` if truly N/A).")
    }
    const jobId = nextJobId()
    const staleHints = detectStaleContextHints(args.task)
    if (staleHints.length > 0) {
      logger.log(jobId, 'stale_context_warning', { matches: staleHints, task_preview: (args.task ?? '').slice(0, 200) })
    }
    const cwd = args.cwd || process.cwd()
    const briefing = args.skip_briefing ? null : await loadBriefing(cwd)
    const taskForWorker = briefing
      ? `# STANDING BRIEFING (auto-injected from ${briefing.path})\n\n${briefing.content}\n\n---\n\n# TASK\n\n${args.task}`
      : args.task
    logger.log(jobId, 'delegate_start', {
      task_preview: (args.task ?? '').slice(0, 200),
      cwd,
      requested_model: args.model,
      fallback: args.fallback,
      briefing_path: briefing?.path ?? null,
    })
    const result = await delegateTask(
      {
        task: taskForWorker,
        cwd,
        timeoutSeconds: args.timeout_seconds,
        totalTimeoutSeconds: args.total_timeout_seconds,
        maxTurns: args.max_turns,
        model: args.model,
        fallback: args.fallback,
        additionalDirs: args.additional_dirs,
      },
      cfg,
      {
        onProgress: (evt) => {
          if (evt.kind === 'engine_start' || evt.kind === 'engine_end') {
            logger.log(jobId, evt.kind, {
              model: evt.model,
              stop_reason: evt.stop_reason,
              duration_ms: evt.duration_ms,
            })
          }
        },
      },
    )
    logger.log(jobId, 'delegate_end', {
      engine_used: result.engine_used,
      stop_reason: result.stop_reason,
      attempts: result.attempts?.length,
      duration_ms: result.duration_ms,
      cost_usd: result.cost_usd,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
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
