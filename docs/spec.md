# Design: minimax-mcp

**Status:** draft, awaiting user approval
**Date:** 2026-05-18
**Owner:** colin

A user-local MCP server that lets a primary Claude Code session delegate scoped tasks to a subprocess Claude Code instance running on MiniMax via the Anthropic-compatible endpoint.

## 1. Motivation

Primary Claude Code (Opus 4.7) is expensive. Most coding work — focused file edits, test loops, small refactors — does not require frontier reasoning. Offload that work to MiniMax-M2.7-highspeed (cheaper, Anthropic-API-compatible) and keep Opus as orchestrator/reviewer.

The savings only materialize if the offloaded work is:
1. Self-contained (primary doesn't need to deeply re-examine it)
2. Cheaply verifiable (tests, type-check, lint, or a quick read)
3. Within MiniMax's quality envelope

If those don't hold, primary spends Opus tokens reviewing/redoing and we lose money. The tool exists to be used selectively, not by default.

## 2. Verified facts about the endpoint

Tested via direct `curl` to `https://api.minimax.io/anthropic/v1/messages` on 2026-05-18:

- Accepts the standard Anthropic Messages API: `x-api-key` header, `anthropic-version: 2023-06-01`, JSON body with `model`, `max_tokens`, `messages`.
- Returns Anthropic-shaped responses: `type: message`, `content[]`, `usage`, `stop_reason`.
- **MiniMax-M2.7-highspeed is an extended-thinking model.** Responses include `thinking` blocks with signatures. Subprocess Claude Code must allow enough `max_tokens` for thinking + output; Claude Code's defaults are sufficient.
- Adds a non-standard `base_resp` field on the response root. Claude Code ignores unknown fields, so this is harmless.

Unverified but assumed for v1 (smoke test will confirm):
- Tool-use blocks work end-to-end (required for Claude Code's agent loop).
- Streaming SSE works with `stream-json` output format.

## 3. Architecture

```
Primary Claude Code (Opus 4.7)
  │  decides what to delegate; holds session/skill state
  │
  ▼  JSON-RPC over stdio (MCP)
minimax-mcp-server (Node 18, @modelcontextprotocol/sdk)
  │  validates inputs, manages subprocess lifecycle, runs fallback chain
  │
  ▼  spawn('claude', [...], { env })  — fallback chain, capability-first
   ┌────────────────────────────────────────────────────────────┐
   │ Attempt 1: MiniMax-M2.7-highspeed                          │
   │   env: ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic │
   │        ANTHROPIC_API_KEY=<MMX key>                         │
   │   on hard failure ↓                                        │
   │ Attempt 2: claude-sonnet-4-6 (real Anthropic)              │
   │   env: ANTHROPIC_BASE_URL unset (default api.anthropic.com)│
   │        ANTHROPIC_API_KEY=<primary's Anthropic key>         │
   │   on hard failure ↓                                        │
   │ Attempt 3: claude-haiku-4-5-20251001 (real Anthropic)      │
   │   on hard failure → return stop_reason='all_engines_failed'│
   └────────────────────────────────────────────────────────────┘
  cwd (all attempts): primary's cwd
  │
  ▼
final stdout (JSON stream) → parsed by server → tool result to primary
                                                (includes `engine_used`)
```

**Key calls:**

- **Node, not Python.** System Python is 3.8; the modern MCP Python SDK requires 3.10+. Node 18 works out of the box.
- **Same cwd as primary.** Maximum power, mirrors how a co-worker would help. Trust boundary moves up to primary: it is primary's job to delegate only well-scoped tasks.
- **`bypassPermissions`** for the subprocess. No human present to approve prompts. Standard for headless `claude -p` use.
- **`stream-json` output.** Lets the server emit MCP progress notifications as the subprocess works.
- **Capability-first fallback (MMX → Sonnet → Haiku).** User choice. Maximizes task-completion probability over cost savings. `engine_used` in the response surfaces what actually ran so primary can see when MMX was bypassed.

## 4. Tool surface

Small surface for v1. Grow only if usage justifies it.

### `delegate_task`

Hand a scoped coding task to a subprocess Claude running on MiniMax.

**Inputs:**
| name | type | required | default | description |
|---|---|---|---|---|
| `task` | string | yes | — | Self-contained instruction. Must include relevant file paths, acceptance criteria, and any context the worker needs (primary's conversation history is not visible to the worker). |
| `cwd` | string | no | primary's cwd | Working directory for the subprocess. |
| `timeout_seconds` | number | no | `600` | Per-attempt SIGTERM; SIGKILL 5s later. Total wall-clock across the fallback chain is capped by `total_timeout_seconds`. |
| `total_timeout_seconds` | number | no | `1800` | Hard cap across the entire fallback chain. If exceeded, no further attempts are started. |
| `max_turns` | number | no | `25` | Hard cap on Claude Code's agent loop (applied per attempt). |
| `model` | string | no | env `MINIMAX_MODEL` | Override the primary model. Fallback chain still applies. |
| `fallback` | boolean | no | `true` | Set `false` to disable auto-fallback (MMX only). On MMX failure, tool returns an error. |
| `additional_dirs` | string[] | no | `[]` | Passed to subprocess as `--add-dir` for multi-root repos. |

**Output:**
| field | type | description |
|---|---|---|
| `final_response` | string | The successful attempt's final assistant text. |
| `engine_used` | string | The model that actually produced `final_response`. One of: `MiniMax-M2.7-highspeed`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (or a configured override). |
| `attempts` | object[] | Per-attempt log: `{ model, stop_reason, duration_ms, error? }`. Lets primary see what failed before success. |
| `turns_used` | number | Agent-loop turns consumed by the *successful* attempt. |
| `duration_ms` | number | Wall-clock for the *successful* attempt. (Total across the chain is implicit in `attempts[]`.) |
| `cost_usd` | number \| null | Successful attempt's self-reported cost if present. Caveat: when `engine_used` is MMX, cost is computed from Anthropic prices not MMX's actual billing. |
| `files_modified` | string[] | Best-effort: collected by watching the subprocess's stream-json output for `Edit`/`Write`/`NotebookEdit` tool calls and recording their `file_path` arg. |
| `stop_reason` | string | `completed` \| `max_turns` \| `timeout` \| `all_engines_failed` |

**Streaming:** while running, server emits MCP progress notifications with truncated activity lines so primary can show status. Engine switches (MMX → Sonnet, etc.) are also emitted as progress events.

### `cancel`

Terminate a running delegate.
- **Input:** `job_id` (string)
- **Behavior:** SIGTERM then SIGKILL 5s later.

### `list_models`

Return the configured default model plus any aliases. Mostly for discovery/debug.

## 5. Subprocess invocation

Two invocation modes — one for MMX, one for Anthropic fallback. Same flags, different env.

**MMX attempt:**
```js
spawn('claude', [
  '--print',
  '--permission-mode', 'bypassPermissions',
  '--output-format', 'stream-json',
  '--verbose',
  '--max-turns', String(maxTurns),
  '--model', model,                      // e.g. MiniMax-M2.7-highspeed
  ...additionalDirs.flatMap(d => ['--add-dir', d]),
  task,
], {
  cwd,
  env: {
    ...sanitizedParentEnv,
    ANTHROPIC_BASE_URL: cfg.minimaxBaseUrl,
    ANTHROPIC_API_KEY:  cfg.minimaxApiKey,
  },
})
```

**Anthropic fallback attempt (Sonnet, then Haiku):**
```js
spawn('claude', [
  '--print',
  '--permission-mode', 'bypassPermissions',
  '--output-format', 'stream-json',
  '--verbose',
  '--max-turns', String(maxTurns),
  '--model', fallbackModel,              // claude-sonnet-4-6, then claude-haiku-4-5-20251001
  ...additionalDirs.flatMap(d => ['--add-dir', d]),
  task,
], {
  cwd,
  env: sanitizedParentEnv,                // NO override — subprocess uses primary's Anthropic auth
})
```

The Anthropic fallback inherits primary's `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` from `process.env` because we deliberately don't strip them when targeting Anthropic. The MMX attempt strips them.

**Env hygiene.** Two distinct env shapes:

- **For the MMX attempt**, the subprocess env explicitly removes Anthropic-side credentials so it cannot fall back to primary's account inside a single attempt:
  - Strip: `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, any inherited `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`.
  - Inject: `ANTHROPIC_BASE_URL=<MMX>`, `ANTHROPIC_API_KEY=<MMX key>`.
- **For Anthropic fallback attempts**, the subprocess env keeps primary's auth intact (we want it to use it).

The point: per-attempt env is unambiguous about which provider it's hitting. No cross-contamination.

**Fallback orchestration:** the server runs attempts sequentially, not in parallel. Each attempt gets its own fresh subprocess, `max_turns`, and `timeout_seconds`. After each attempt, the server checks `total_timeout_seconds` before starting the next.

**What counts as "hard failure" (triggers fallback):**
- HTTP 401/403/5xx from the API endpoint
- Network error / DNS failure
- Subprocess exit with non-zero code
- 429 *after* MMX's own retry budget (3× exponential backoff) is exhausted
- Subprocess timeout — falls back **once** to the next engine, then stops (a task that times out on Sonnet is unlikely to succeed on Haiku, and running both costs real money)

**What does NOT trigger fallback:**
- `stop_reason: max_turns` on the subprocess (task hit its turn budget — that's the task, not the engine)
- A "successful" response that primary considers low-quality (quality is primary's call, not the tool's)

## 6. Error handling

Per-attempt behavior. The fallback chain (§3, §5) wraps this.

| condition | behavior |
|---|---|
| missing/empty MMX env var at startup | server fails fast, logs which var is missing, exits non-zero |
| missing Anthropic auth when fallback is needed | log warning; chain stops at last successful provider |
| 401/403 from current endpoint | trigger fallback (no retry on this attempt) |
| 429 from current endpoint | exponential backoff (1s, 2s, 4s) up to 3 retries, then trigger fallback |
| 5xx from current endpoint | trigger fallback (no retry) |
| network/DNS error | trigger fallback |
| subprocess crash (non-zero exit) | trigger fallback; stderr captured into `attempts[].error` |
| subprocess timeout (per-attempt) | SIGTERM → SIGKILL 5s; trigger fallback **once**, then stop |
| `total_timeout_seconds` exceeded | abort chain; return `stop_reason: 'timeout'` with `attempts[]` log |
| all engines exhausted | return `stop_reason: 'all_engines_failed'`, `final_response: null`, full `attempts[]` |
| malformed JSON in stream | log raw line, continue; non-fatal |
| `fallback: false` and MMX fails | return error immediately; no fallback attempted |

## 7. Secrets & configuration

- `~/.minimax-mcp/.env`, mode `0600`, gitignored. Loaded via `dotenv` on server startup.
- Required env:
  - `MINIMAX_API_KEY` — MiniMax API key
  - `MINIMAX_BASE_URL` — defaults to `https://api.minimax.io/anthropic` if absent
  - `MINIMAX_MODEL` — defaults to `MiniMax-M2.7-highspeed` if absent
- Optional env (fallback chain — overridable):
  - `MINIMAX_FALLBACK_MODELS` — comma-separated list. Default: `claude-sonnet-4-6,claude-haiku-4-5-20251001`.
- Anthropic auth for fallback attempts is **inherited from the parent process env** (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`). If neither is present, fallback attempts will fail with an auth error and the chain stops.
- Server **never logs** `MINIMAX_API_KEY` or any Anthropic auth value. All log statements that might touch env values mask anything matching a known secret.
- `.gitignore` includes `.env`, `node_modules/`, `*.log`.

## 8. File layout

```
~/.minimax-mcp/
├── .env                 (0600, gitignored)
├── .gitignore
├── package.json
├── README.md            (user-facing setup)
├── docs/
│   └── superpowers/specs/2026-05-18-minimax-mcp-design.md  (this file)
├── src/
│   ├── server.js        (MCP server entry, registers tools)
│   ├── config.js        (dotenv loader + validation)
│   ├── delegate.js      (delegate_task implementation)
│   ├── spawn-claude.js  (subprocess wrapper, stream parser)
│   └── jobs.js          (in-memory job registry for cancel)
└── test/
    └── smoke.test.js    (single-file integration smoke)
```

## 9. Registration in Claude Code

`~/.claude/settings.json`:
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

(Merged into existing settings.json, not replacing it.)

## 10. Testing strategy

Three layers, smallest first:

1. **Wiring smoke (manual).** After registration: `mcp__minimax__list_models`. Verifies server is registered, tool surface is reachable. No MMX call.
2. **Trivial-task smoke (manual).** `mcp__minimax__delegate_task` with `task: "Create /tmp/minimax-test/hello.txt containing the word PONG. Then exit."` Verifies subprocess spawn, env wiring, file editing, and round-trip.
3. **Scripted integration test.** `test/smoke.test.js` spawns the server, sends a `tools/list` and a `tools/call` for `list_models` over stdio, asserts response shapes. No live MMX call (pure server-side test).

No unit tests for the spawn glue — too thin to be worth mocking against.

## 11. Risks & open questions

- **MiniMax-M2.7-highspeed quality on agentic coding is unmeasured.** Smoke test will be subjective. If outputs are poor we adjust the model env or the task framing; we do not change the architecture.
- **Anthropic-compat feature gaps likely.** Prompt caching, batch, files API, computer use, MCP-over-HTTP probably absent. v1 doesn't depend on any of them. Tool-use streaming is required and assumed; smoke test (task #2) will confirm.
- **Cost accounting is approximate.** Subprocess Claude Code reports `cost_usd` from Anthropic prices, not MiniMax's real billing. We surface it with a caveat.
- **No context inheritance.** Subprocess starts fresh. Primary must write thorough task descriptions. Future enhancement: optional `context_summary` field that primary fills in.
- **Concurrent calls.** v1 allows multiple in-flight delegates (each is independent). No queueing or global rate limit.
- **Trust boundary in same-cwd mode.** Subprocess can read/edit any file primary can. Acceptable for a personal tool; would not be for shared/multi-tenant use.
- **Silent Anthropic token spend on fallback.** When MMX hard-fails, the chain spends real Anthropic tokens (Sonnet then Haiku) without an interactive confirmation. The user has accepted this trade for "the work gets done" reliability. Mitigations: `engine_used` field surfaces what ran; `attempts[]` log shows the full path; `fallback: false` opt-out is supported per-call.

## 12. Non-goals (v1)

- No OpenAI-compatible fallback, no aider/opencode/crush wrapper.
- No persistent worker process (every call is a fresh subprocess).
- No cross-call conversation memory.
- No automatic context summarization from primary's session.
- No fine-grained permission scoping for the subprocess (it's `bypassPermissions` or nothing).
- No worktree isolation. (Was on the table; user chose same-cwd.)

## 13. Open decisions captured during brainstorming

| decision | choice | rationale |
|---|---|---|
| Workload shape | Agentic sub-runner | User chose; biggest leverage |
| Agent engine | Claude Code subprocess on MMX | Anthropic-compat endpoint makes this trivial |
| Worker scope | Same cwd as primary | User chose; max power, primary owns scoping |
| MCP language | Node 18 | Python 3.8 too old for MCP SDK |
| Default model | MiniMax-M2.7-highspeed | User specified |
| Secrets location | `~/.minimax-mcp/.env` (0600) | Keeps key out of settings.json/git |
| Permission mode | `bypassPermissions` | Required for headless subprocess |
| Fallback chain | MMX → Sonnet → Haiku (auto) | User chose capability-first; reliability over credit savings; surfaced via `engine_used` |
| Fallback on quality | No | Only hard failures trigger fallback; quality judgment stays with primary |
| Fallback on timeout | One step only | Repeated timeouts likely indicate the task, not the engine |
