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
