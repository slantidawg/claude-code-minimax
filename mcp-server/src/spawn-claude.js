// src/spawn-claude.js
const STRIPPED_FOR_MMX = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_API_KEY_HELPER',
  'CLAUDE_CODE_OAUTH_TOKEN',
]

export function buildAttempt({ provider, model, task, cwd, maxTurns, additionalDirs = [], cfg, parentEnv }) {
  const args = [
    '--print',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns),
    '--model', model,
    ...additionalDirs.flatMap(d => ['--add-dir', d]),
    task,
  ]

  let env
  if (provider === 'minimax') {
    env = { ...parentEnv }
    for (const k of STRIPPED_FOR_MMX) delete env[k]
    env.ANTHROPIC_BASE_URL = cfg.baseUrl
    env.ANTHROPIC_API_KEY = cfg.apiKey
  } else if (provider === 'anthropic') {
    env = { ...parentEnv }
  } else {
    throw new Error(`Unknown provider: ${provider}`)
  }

  return { command: 'claude', args, options: { cwd, env } }
}
