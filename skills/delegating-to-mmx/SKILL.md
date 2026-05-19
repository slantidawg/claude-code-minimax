---
name: delegating-to-mmx
description: Use when starting any well-scoped coding task (writing/editing files, implementing functions, running tests, refactoring) — default to mcp__minimax__delegate_task instead of doing the work locally. Encodes the orchestration discipline that turns delegation from a cost trap into a cost saver. Also use when reviewing the output of a delegate_task call to know what to verify.
---

# Delegating coding work to MiniMax

This MCP runs `MiniMax-M2.7-highspeed` with automatic fallback to `claude-sonnet-4-6` then `claude-haiku-4-5-20251001` on hard failure. Use it as the default execution path for coding work.

## When TO delegate

Default to `mcp__minimax__delegate_task` for:
- Writing or editing files
- Implementing a function or fixing a bug with clear scope
- Running tests or build commands as part of an iteration
- Mechanical refactors with a clear target

## When NOT to delegate

- The task hinges on this session's conversation context that can't be summarized into a self-contained `task` string.
- Inline is faster (one-line edit, single grep, single file Read).
- It's orchestration itself — planning, reviewing delegated output, deciding what to delegate next.

If you find yourself wanting to write "as you did before" or "continue where you left off", **stop**. The subprocess is a fresh process with no memory of any prior call. Either summarize the prior state into the brief, or do the work yourself.

## Orchestration discipline (apply on every call)

Bad delegation costs *more* than doing the work locally. First-attempt failure mode is over-broad scope + missing context → wasted turns → repeated delegations → misdiagnosis. To avoid that:

1. **One fix pattern across few files.** If the work spans concerns (backend + frontend + tests), split into separate delegations.
2. **Point at the standing briefing first.** If the project has a `docs/MMX_BRIEFING.md` or `MMX_BRIEFING.md` at its root, the MCP server auto-prepends it. You don't need to repeat its content — just respect it.
3. **Paste fixture/context contents verbatim.** Don't make the worker discover them — copy current file contents into the brief.
4. **Specify edits with line numbers and rationale.** Not "fix the bug" — tell it which lines to change and why.
5. **Regression checks in `acceptance_commands`**, not as an afterthought. The tool's schema requires this field — fill it with the runnable verification you'd use yourself.
6. **Verify yourself before claiming success.** Run the `acceptance_commands` after the call returns. Reading `final_response` is not enough.

## Required tool argument: `acceptance_commands`

The `delegate_task` tool requires an `acceptance_commands: string[]` argument. This is deliberate — it forces verification thinking before the call. Examples:

```json
"acceptance_commands": ["cd /project && pytest tests/auth.py -v", "cd /project && tsc --noEmit"]
```

If the task is truly verification-impossible (docs-only edit), pass `[]` and document the rationale in the `task` arg. Don't skip the field — the server will reject the call.

## After every delegate_task

- Check `engine_used`. If it's not `MiniMax-M2.7-highspeed`, MMX was bypassed via fallback. Note it to the user; repeated MMX failures may need investigation.
- Inspect `attempts[]` for unexpected errors.
- **Run the `acceptance_commands` yourself.** Don't trust the worker's "all tests pass" claim — re-run and confirm.
- If the worker hit `max_turns`, the brief was probably over-scoped. Don't blindly re-delegate; redesign the brief into smaller chunks first.

## Self-contained brief structure (template)

When writing the `task` argument, follow this shape:

```
TASK: [one sentence what]

WORKING DIRECTORY: [absolute path]

CURRENT STATE (verbatim, no summarization):
[paste relevant file contents, current failing output, exact error messages]

EXACT EDITS:
1. [file]:[line range] — change [old] to [new]. Why: [rationale]
2. ...

CONSTRAINTS:
- [files NOT to touch]
- [patterns NOT to use]
- [tests NOT to add]

DEFINITION OF DONE:
- [explicit observable outcomes]
- Commit with message: "[exact message]"
```

The `acceptance_commands` array is filled in *separately* on the tool call — not inside the task arg.

## Signs the brief is wrong (catch before delegating)

- Contains phrases like "your previous", "as you did", "earlier you", "continue where you left off" — these reference state the fresh worker doesn't have. The server logs `stale_context_warning` when it detects them; check `~/.minimax-mcp/server.log` (or the configured `MINIMAX_MCP_LOG_PATH`).
- Spans more than ~4 files of unrelated concerns.
- Says "fix the bug" without specifying which lines and why.
- Has no `acceptance_commands` you'd actually trust as verification.
- Tells the worker to "make a judgment call" on something the orchestrator should have decided.

When you spot these in your draft brief, fix them before sending — they predict the $10-and-fail outcome.

## Cost visibility

The slash command `/mmx-cost` summarizes spend from `~/.minimax-mcp/server.log` (today by default, `/mmx-cost 7` for a week). Check it occasionally — a steady drip of fallbacks to Sonnet means MMX is failing and the cost-savings story isn't holding.
