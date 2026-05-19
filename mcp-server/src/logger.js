import { appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_LOG_PATH = process.env.MINIMAX_MCP_LOG_PATH
  || join(homedir(), '.minimax-mcp', 'server.log')

let counter = 0
export function nextJobId() {
  return `j${Date.now().toString(36)}${(++counter).toString(36)}`
}

export function createLogger(path = DEFAULT_LOG_PATH) {
  return {
    path,
    log(jobId, kind, payload = {}) {
      const ts = new Date().toISOString()
      const line = JSON.stringify({ ts, jobId, kind, ...payload }) + '\n'
      appendFile(path, line).catch(() => {})
    },
  }
}
