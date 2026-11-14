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
  shape: 'snap-2',
})

// A once-a-second counter: bumping it redraws the pane so the reset countdowns tick.
const tick = atom({ plugin: 'usage-monitor', key: 'tick' } as const, 0, {
  shape: 'tick-1',
})
let stopTick: (() => void) | undefined

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
  const t = Math.floor(ms / 1000)
  const s = t % 60
  const m = Math.floor(t / 60) % 60
  const h = Math.floor(t / 3600)
  const d = Math.floor(h / 24)
  const p = (n: number) => String(n).padStart(2, '0')
  const left = d >= 1 ? `${d}d ${h % 24}h ${p(m)}m` : `${h}:${p(m)}:${p(s)}`
  return ` reset ${when(Date.parse(iso))} · za ${left}`
}

const DAYS_PL = ['ND', 'PON', 'WT', 'ŚR', 'CZW', 'PT', 'SOB']
const DAYS_EN: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// "CZW 19.11 09:00" in Polish time, the date taken from the reset timestamp itself
// (falls back to the machine's local time if Intl is missing).
const when = (ms: number) => {
  const p = (n: number) => String(n).padStart(2, '0')
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Warsaw',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms))
    const get = (t: string) => parts.find(x => x.type === t)?.value ?? ''
    const day = DAYS_EN[get('weekday')]
    if (day !== undefined) {
      return `${DAYS_PL[day]} ${get('day')}.${get('month')} ${get('hour')}:${get('minute')}`
    }
  } catch {}
  const dt = new Date(ms)
  return `${DAYS_PL[dt.getDay()]} ${p(dt.getDate())}.${p(dt.getMonth() + 1)} ${p(dt.getHours())}:${p(dt.getMinutes())}`
}

// Snapshots live in <home>/.claude/usage-monitor/sessions, so the floating window can read them.
const dirOf = async ($: any): Promise<string> => {
  let home = ''
  try { home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '' } catch {}
  return `${home.replace(/\\/g, '/')}/.claude/usage-monitor/sessions`
}

// The engine's cost counter restarts with the process. cumUsd keeps a running total across
// restarts: each change of the engine's figure adds the difference (or the whole figure, when
// it dropped, i.e. after a restart). The previous total is read back from this chat's file.
const trackCost = async ($: any) => {
  try {
    const s0 = await read($, snap)
    const usd = s0.usd
    if (usd === undefined) return
    let base: { cum: number; last: number } | undefined
    if (s0.cumUsd === undefined) {
      try {
        const id: string = await $.session.id()
        const p = JSON.parse(await $.fs.read(`${await dirOf($)}/${id}.json`))
        base = { cum: p.cumUsd ?? p.usd ?? 0, last: p.lastUsd ?? p.usd ?? 0 }
      } catch {}
    }
    await update($, snap, s => {
      const cum0 = s.cumUsd ?? base?.cum ?? 0
      const last0 = s.cumUsd === undefined ? (base?.last ?? 0) : (s.lastUsd ?? 0)
      const delta = usd >= last0 ? usd - last0 : usd
      return { ...s, cumUsd: cum0 + delta, lastUsd: usd }
    })
  } catch {}
}

const publish = async ($: any) => {
  try {
    await trackCost($)
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
    const total = s.cumUsd ?? s.usd
    if (total !== undefined) parts.push(`$${total.toFixed(2)}`)
    if (parts.length) $.ui.status(parts.join(' · '))
    await $.fs.write(`${await dirOf($)}/${id}.json`, JSON.stringify({ ...s, id, cwd, at: Date.now() }))
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-monitor',
      description: 'Open the live usage / context / cache pane',
    })
    void $.ui.open({ id: PANE, title: 'Usage' })
    stopTick?.()
    stopTick = $.clock.every(1000, () => {
      void update($, tick, n => n + 1)
    })
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
    await read($, tick) // subscribe: redraw every second so countdowns tick

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
              Koszt łącznie: <Text bold>${(s.cumUsd ?? s.usd).toFixed(2)}</Text>
            </Text>
            <Text dimColor>od ostatniego restartu: ${s.usd.toFixed(2)}</Text>
          </Box>
        )}
        {s.last && <Text dimColor>{s.last.model}</Text>}
      </Box>
    )
  })
}
