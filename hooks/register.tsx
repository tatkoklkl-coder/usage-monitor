import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snap } from '../types'

const PANE = 'usage-monitor'

const empty: Snap = {
  window: 0,
  limits: [],
  total: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 },
}

const snap = atom({ plugin: 'usage-monitor', key: 'snap' } as const, empty, {
  shape: 'snap-1',
})

const fmt = (n: number | undefined) => {
  if (n === undefined) return '–'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}

const bar = (pct: number, width = 24) => {
  const p = Math.max(0, Math.min(100, pct))
  const full = Math.round((p / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

const colorFor = (pct: number) => (pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green')

const label = (kind: string) =>
  kind === 'five_hour' ? 'Limit 5h' : kind === 'seven_day' ? 'Limit 7 dni' : kind

const resets = (iso?: string) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return ' (reset)'
  const m = Math.round(ms / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  return d >= 1 ? ` reset za ${d}d ${h % 24}h` : h >= 1 ? ` reset za ${h}h ${m % 60}m` : ` reset za ${m}m`
}

const DIR = 'C:/Users/PLEYNET/.claude/usage-monitor/sessions'

const publish = async ($: any) => {
  try {
    const id: string = await $.session.id()
    let cwd = ''
    try { cwd = await $.session.cwd() } catch {}
    const s = await read($, snap)
    const parts: string[] = []
    for (const l of s.limits) parts.push(`${l.kind === 'five_hour' ? '5h' : l.kind === 'seven_day' ? '7d' : l.kind} ${Math.round(l.percentUsed)}%`)
    if (s.percent !== undefined) parts.push(`ctx ${s.percent}%`)
    if (s.last) {
      const all = s.last.cacheRead + s.last.cacheWrite + s.last.input
      if (all > 0) parts.push(`cache ${Math.round((s.last.cacheRead / all) * 100)}%`)
    }
    if (s.usd !== undefined) parts.push(`$${s.usd.toFixed(2)}`)
    if (parts.length) $.ui.status(parts.join(' · '))
    await $.fs.write(`${DIR}/${id}.json`, JSON.stringify({ ...s, id, cwd, at: Date.now() }))
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-monitor',
      description: 'Open the live usage / context / cache pane',
    })
    void $.ui.open({ id: PANE, title: 'Usage' })
    try {
      const u = await $.session.usage()
      await update($, snap, s => ({
        ...s,
        tokens: u.context.tokens,
        window: u.context.window,
        percent: u.context.percent,
        limits: u.rateLimits.map(r => ({ ...r })),
        usd: u.cost?.usd,
      }))
      await publish($)
    } catch {}
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snap, s => ({
      ...s,
      tokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      limits: e.rateLimits.map(r => ({ ...r })),
      usd: e.cost?.usd,
    }))
    await publish($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u && !e.agentId) {
      await update($, snap, s => ({
        ...s,
        last: {
          input: u.input_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
          output: u.output_tokens,
          model: u.model,
        },
        total: {
          input: s.total.input + u.input_tokens,
          cacheRead: s.total.cacheRead + u.cache_read_input_tokens,
          cacheWrite: s.total.cacheWrite + u.cache_creation_input_tokens,
          output: s.total.output + u.output_tokens,
          turns: s.total.turns + 1,
        },
      }))
      await publish($)
    }
    return next(e)
  })

  on('command.run', { command: 'usage-monitor' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage' })
    return { text: 'Usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)

    const ctxPct = s.percent ?? (s.tokens && s.window ? (s.tokens / s.window) * 100 : undefined)

    const hitOf = (r: number, w: number, i: number) => {
      const all = r + w + i
      return all > 0 ? (r / all) * 100 : undefined
    }
    const lastHit = s.last ? hitOf(s.last.cacheRead, s.last.cacheWrite, s.last.input) : undefined
    const totHit = hitOf(s.total.cacheRead, s.total.cacheWrite, s.total.input)

    return (
      <Box flexDirection="column">
        <Text bold>USAGE (limity konta)</Text>
        {s.limits.length === 0 && <Text dimColor>brak danych (poczekaj na pierwszą odpowiedź)</Text>}
        {s.limits.map(l => (
          <Box flexDirection="column">
            <Text>
              {label(l.kind)} {l.percentUsed.toFixed(1)}%
              <Text dimColor>{resets(l.resetsAt)}</Text>
            </Text>
            <Text color={colorFor(l.percentUsed)}>{bar(l.percentUsed)}</Text>
          </Box>
        ))}

        <Text> </Text>
        <Text bold>KONTEKST</Text>
        {ctxPct === undefined ? (
          <Text dimColor>brak danych (świeża sesja / po compact)</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              {fmt(s.tokens)} / {fmt(s.window)} ({ctxPct.toFixed(0)}%)
            </Text>
            <Text color={colorFor(ctxPct)}>{bar(ctxPct)}</Text>
          </Box>
        )}

        <Text> </Text>
        <Text bold>CACHE</Text>
        {s.last ? (
          <Box flexDirection="column">
            <Text>
              ostatnia tura: trafienia {lastHit === undefined ? '–' : lastHit.toFixed(0) + '%'}
            </Text>
            {lastHit !== undefined && <Text color={lastHit >= 70 ? 'green' : lastHit >= 40 ? 'yellow' : 'red'}>{bar(lastHit)}</Text>}
            <Text dimColor>
              odczyt {fmt(s.last.cacheRead)} · zapis {fmt(s.last.cacheWrite)} · świeże {fmt(s.last.input)} · wyjście {fmt(s.last.output)}
            </Text>
            <Text>
              sesja ({s.total.turns} tur): {totHit === undefined ? '–' : totHit.toFixed(0) + '%'} trafień
            </Text>
            <Text dimColor>
              odczyt {fmt(s.total.cacheRead)} · zapis {fmt(s.total.cacheWrite)} · świeże {fmt(s.total.input)} · wyjście {fmt(s.total.output)}
            </Text>
          </Box>
        ) : (
          <Text dimColor>czekam na pierwszą turę…</Text>
        )}

        {s.usd !== undefined && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text>
              Koszt sesji: <Text bold>${s.usd.toFixed(2)}</Text>
            </Text>
          </Box>
        )}
        {s.last && <Text dimColor>{s.last.model}</Text>}
      </Box>
    )
  })
}
