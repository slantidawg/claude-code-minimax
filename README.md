# claude-code-minimax

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Plugin: Claude Code](https://img.shields.io/badge/Plugin-Claude%20Code-blue)](https://docs.claude.com/claude-code)
[![MCP](https://img.shields.io/badge/MCP-1.x-green)](https://modelcontextprotocol.io)

Delegate scoped coding work from Claude Code to **MiniMax-M2.7-highspeed** (via MiniMax's Anthropic-compatible endpoint), with automatic fallback to `claude-sonnet-4-6` then `claude-haiku-4-5-20251001` on hard failure. Bundles the MCP server, an orchestration-discipline skill, and a cost-summary slash command.

## Why this exists

Frontier-model tokens are expensive. Most coding work — focused file edits, test loops, small refactors — does not require frontier reasoning. This plugin offloads that work to MiniMax (cheap, fast, Anthropic-API-compatible) and keeps your primary Claude session as orchestrator / reviewer.

**Critical caveat: bad delegations cost more than doing the work yourself.** From the same project, two real delegations:

| | Brief style | Files | Turns | Cost | Result |
|---|---|---|---|---|---|
| Attempt 1 | over-broad, no fixture context, "as you did before" references | 7 | 41 (max) | **$10.81** | misdiagnosed; required 3 delegations |
| Attempt 2 | scoped, fixtures pasted verbatim, line-precise edits, runnable acceptance commands | 2 | 10 / 15 | **$0.82** | correct first try, single verification pass |

Same model. Same project. **13× cost delta, all in brief discipline.** The plugin ships an opinionated skill that encodes what changed between attempts. The skill is half the value.

## What's in the box

| Component | Purpose |
|---|---|
| `mcp-server/` | The MCP server (Node 18+ ESM) that spawns `claude --print` subprocesses with MMX env, runs the fallback chain, parses stream-json, and logs cost/turns/engine per call. |
| `skills/delegating-to-mmx/` | The orchestration discipline as a skill. Auto-triggers when Claude encounters a coding task; tells it to default to `mcp__minimax__delegate_task` and follow the six-point brief discipline. |
| `commands/mmx-cost.md` | `/mmx-cost [days_back]` — summarize delegation spend from `~/.minimax-mcp/server.log`. |
| `templates/MMX_BRIEFING.md` | Skeleton for a per-project briefing. The MCP server auto-prepends `MMX_BRIEFING.md` or `docs/MMX_BRIEFING.md` from cwd to every delegated task. |
| `docs/spec.md` | Full design spec — architecture, tool surface, error handling, security. |
| `docs/plan.md` | Original implementation plan — useful as a reference for extending the server. |

## What it looks like

**Calling the tool** (primary Claude assembles this; you don't usually hand-write it):

```json
{
  "task": "TASK: rename helper `getUser` to `loadUser` in src/auth.ts.\n\nCURRENT STATE: src/auth.ts line 14 defines `export function getUser(id: string)`. Callers in src/routes/me.ts:8, src/middleware/session.ts:22.\n\nEDITS:\n1. src/auth.ts:14 — change `getUser` to `loadUser`\n2. src/routes/me.ts:8 — update import + call site\n3. src/middleware/session.ts:22 — update import + call site\n\nDEFINITION OF DONE: npm test passes, no other files changed.",
  "cwd": "/home/me/project",
  "acceptance_commands": ["cd /home/me/project && npm test", "cd /home/me/project && tsc --noEmit"],
  "max_turns": 10
}
```

**Response** (excerpt — the full result has more fields):

```json
{
  "engine_used": "MiniMax-M2.7-highspeed",
  "stop_reason": "completed",
  "final_response": "Renamed getUser → loadUser at all 3 call sites. npm test: 47 passed. tsc --noEmit: clean.",
  "attempts": [
    { "model": "MiniMax-M2.7-highspeed", "stop_reason": "completed", "duration_ms": 47230, "error": null }
  ],
  "turns_used": 7,
  "duration_ms": 47230,
  "cost_usd": 0.0921,
  "files_modified": ["src/auth.ts", "src/routes/me.ts", "src/middleware/session.ts"]
}
```

**Server log** (`~/.minimax-mcp/server.log`, one JSON line per event):

```
{"ts":"2026-05-19T14:21:03Z","jobId":"j7a3b9","kind":"delegate_start","cwd":"/home/me/project","briefing_path":"/home/me/project/docs/MMX_BRIEFING.md"}
{"ts":"2026-05-19T14:21:03Z","jobId":"j7a3b9","kind":"engine_start","model":"MiniMax-M2.7-highspeed"}
{"ts":"2026-05-19T14:21:50Z","jobId":"j7a3b9","kind":"engine_end","model":"MiniMax-M2.7-highspeed","stop_reason":"completed","duration_ms":47230}
{"ts":"2026-05-19T14:21:50Z","jobId":"j7a3b9","kind":"delegate_end","engine_used":"MiniMax-M2.7-highspeed","attempts":1,"duration_ms":47230,"cost_usd":0.0921}
```

**Slash command — `/mmx-cost`:**

```
=== MiniMax MCP usage — Today (since 2026-05-19) ===
Total: 8 delegations  $4.7218
  MiniMax-M2.7-highspeed: 7 calls  $4.6297  avg 42100 ms
  claude-sonnet-4-6: 1 calls  $0.0921  avg 31400 ms

Non-completed outcomes (1):
  2026-05-19T11:04:12Z  MiniMax-M2.7-highspeed: max_turns
```

## Setup (one-time, ~3 minutes)

### 1. Install the plugin

If you maintain your own marketplace, register this repo in `~/.claude/plugins/known_marketplaces.json`. Otherwise:

```bash
# Direct install from the repo (adjust the path to where you cloned this):
/plugin install /path/to/minimax-mcp-plugin
```

Or, if you've published it to a marketplace:

```bash
/plugin install minimax-mcp@<your-marketplace>
```

### 2. Get a MiniMax API key

Sign up at <https://www.minimaxi.com/> (international) or your regional MiniMax portal. Generate an API key from the platform console.

### 3. Install the MCP server's npm dependencies

The plugin ships the server source but not the npm dependencies — install them once:

```bash
cd "$(find ~/.claude/plugins -type d -name mcp-server -path '*minimax-mcp*' | head -1)" && npm install
```

(That `find` resolves to the plugin's `mcp-server/` after install. You can also pass the path directly if you know it.)

### 4. Create the env file

The server reads `~/.minimax-mcp/.env` by default (independent of where the plugin is installed, so it survives upgrades).

```bash
mkdir -p ~/.minimax-mcp
cat > ~/.minimax-mcp/.env <<'EOF'
MINIMAX_API_KEY=<paste your key here>
MINIMAX_BASE_URL=https://api.minimax.io/anthropic
MINIMAX_MODEL=MiniMax-M2.7-highspeed
# Optional override of the fallback chain:
# MINIMAX_FALLBACK_MODELS=claude-sonnet-4-6,claude-haiku-4-5-20251001
EOF
chmod 600 ~/.minimax-mcp/.env
```

If you want the env file somewhere else, set `MINIMAX_MCP_ENV_PATH` in your shell and the server will respect it.

### 5. Restart Claude Code

The MCP server registers at session start. After restart, run `/mcp` and confirm `minimax` is listed.

## First-call smoke test

In a fresh session, ask Claude to call `mcp__minimax__delegate_task` with:

```json
{
  "task": "Create the file /tmp/minimax-smoke/hello.txt containing exactly the single line: PONG\nThen stop.",
  "cwd": "/tmp/minimax-smoke",
  "max_turns": 5,
  "timeout_seconds": 120,
  "acceptance_commands": ["test -f /tmp/minimax-smoke/hello.txt && cat /tmp/minimax-smoke/hello.txt"]
}
```

Then verify:

```bash
mkdir -p /tmp/minimax-smoke  # ensure cwd exists
# ... ask Claude to make the call ...
cat /tmp/minimax-smoke/hello.txt  # should print PONG
```

The tool's response includes `engine_used` — if it's `MiniMax-M2.7-highspeed`, MMX answered. If it's a Claude model, MMX failed and a fallback rescued the call.

## Per-project briefing

Copy `templates/MMX_BRIEFING.md` into each project where you'll use MMX, fill in the project-specific conventions, and place it at one of:
- `<repo root>/MMX_BRIEFING.md`
- `<repo root>/docs/MMX_BRIEFING.md`

The MCP server auto-prepends the briefing's contents to every `delegate_task` call whose `cwd` is inside that repo. You don't need to reference it manually.

## Tools surfaced

### `delegate_task` (required: `task`, `acceptance_commands`)

| field | type | notes |
|---|---|---|
| `task` | string | Self-contained brief. See the `delegating-to-mmx` skill for the template. |
| `acceptance_commands` | string[] | Runnable verification commands. Required — forces verification thinking up front. Pass `[]` with rationale if truly N/A. |
| `cwd` | string | Defaults to caller cwd. The server looks here for `MMX_BRIEFING.md` to auto-prepend. |
| `max_turns` | number | Default 25. The agent-loop cap. |
| `timeout_seconds` | number | Default 600. Per-attempt timeout. |
| `total_timeout_seconds` | number | Default 1800. Whole-chain cap. |
| `fallback` | boolean | Default true. Set false to disable Sonnet/Haiku rescue. |
| `model` | string | Override the primary model. |
| `skip_briefing` | boolean | Skip auto-prepending `MMX_BRIEFING.md`. |
| `additional_dirs` | string[] | `--add-dir` for multi-root repos. |

Returns: `{ engine_used, final_response, attempts[], turns_used, duration_ms, cost_usd, files_modified, stop_reason }`.

### `list_models`

Lists the configured primary model and the fallback chain. Diagnostic only.

## Observability

`~/.minimax-mcp/server.log` accumulates one JSON line per event:
- `delegate_start` — task preview, cwd, briefing path (if any), requested model.
- `engine_start` / `engine_end` — per attempt, with stop_reason and duration.
- `delegate_end` — total duration, engine used, cost, stop reason.
- `stale_context_warning` — fires when the brief contains phrases like "your previous", "as you did before", "continue where you left off". Doesn't block, just surfaces the smell.

`/mmx-cost` reads this log and prints today's spend by engine. `/mmx-cost 7` for a week.

## Architecture

```
Primary Claude (any model)
  │  decides what to delegate, holds skill/conversation state
  ▼
mcp__minimax__delegate_task
  │  validates schema (acceptance_commands required), auto-prepends briefing
  ▼
delegate.js: runs fallback chain sequentially
  ▼
spawn 'claude --print' subprocess
  env: ANTHROPIC_BASE_URL=<MiniMax>, ANTHROPIC_API_KEY=<MiniMax key>
       (Anthropic auth stripped to prevent cross-contamination)
  ▼
subprocess does the work in cwd, returns stream-json
  ▼
parsed → returned to primary as structured result
```

See `docs/spec.md` for the full design.

## Security notes

- The MCP server **strips** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, and `CLAUDE_CODE_API_KEY_HELPER` from the subprocess env on MMX attempts — primary's Anthropic credentials cannot leak to MiniMax.
- The MCP server **preserves** parent env on Anthropic fallback attempts — Sonnet/Haiku attempts use primary's existing auth.
- `acceptance_commands` are not executed by the MCP server; they're passed to the worker (or you) to run. The server is not a sandboxed executor.
- Subprocess runs with `--permission-mode=bypassPermissions`. The worker can read/edit any file the caller can. The trust boundary is the brief: you delegate well-scoped tasks, the worker has authority within that scope.

## Tests

26 tests, run with the bundled Node test runner:

```bash
cd <plugin>/mcp-server && npm test
```

## License

MIT — see `LICENSE`.
