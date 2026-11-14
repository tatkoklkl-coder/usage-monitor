export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snap = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  // when `limits` was last read (ms), here or adopted from another chat via limits.json
  limitsAt?: number
  usd?: number
  // running total across restarts, and the engine's last reading it was built from
  cumUsd?: number
  lastUsd?: number
  // cost since this module loaded (starts at 0)
  sinceUsd?: number
  // prompt-cache countdown: when the last main-loop turn touched the cache (ms), the TTL in use
  // (ms; assumed 1 h until a gap longer than 5 min shows otherwise) and whether it was observed
  cacheAt?: number
  ttlMs?: number
  ttlSure?: boolean
  // where the TTL came from: the API's per-write split, read from the chat's transcript file
  ttlSrc?: 'api'
  // why the transcript could not be read, when it could not
  ttlErr?: string
  // last main-loop turn
  last?: { input: number; cacheRead: number; cacheWrite: number; output: number; model: string }
  // session totals
  total: { input: number; cacheRead: number; cacheWrite: number; output: number; turns: number }
}

declare module 'claude-code' {
  interface PluginState {
    'usage-monitor': { snap: Shaped<Snap>; tick: Shaped<number> }
  }
}
