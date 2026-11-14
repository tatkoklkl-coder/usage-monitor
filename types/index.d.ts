export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snap = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  usd?: number
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
