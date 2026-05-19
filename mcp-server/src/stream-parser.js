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
