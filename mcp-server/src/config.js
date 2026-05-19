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
  const parsed = {}
  loadEnv({ path, override: false, processEnv: parsed })
  return buildConfig({ ...process.env, ...parsed })
}
