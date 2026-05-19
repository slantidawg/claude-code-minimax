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
    assert.deepEqual(names, ['delegate_task', 'list_models'])

    const lm = await rpc(proc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_models', arguments: {} } })
    const payload = JSON.parse(lm.result.content[0].text)
    assert.equal(payload.default, 'MiniMax-M2.7-highspeed')
    assert.deepEqual(payload.fallbacks, ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'])
  } finally {
    proc.kill('SIGTERM')
  }
})
