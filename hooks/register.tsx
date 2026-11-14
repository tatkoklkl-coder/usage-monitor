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

// Prompt-cache countdown. The engine does not report the TTL to mods; the chat's transcript file
// does (readTranscript). Until the file says, the entry is known only to live 5 min to 1 h.
const MIN_TTL = 300_000
const MAX_TTL = 3_600_000
const clock = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000))
  const p = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(t / 3600)
  const m = Math.floor(t / 60) % 60
  return h > 0 ? `${h}:${p(m)}:${p(t % 60)}` : `${m}:${p(t % 60)}`
}
// Time left (ms) to the earliest and to the latest possible expiry; equal once the TTL is observed.
const cacheLeft = (s: Snap) => {
  if (!s.cacheAt) return undefined
  const now = Date.now()
  if (s.ttlSure && s.ttlMs !== undefined) {
    const l = s.cacheAt + s.ttlMs - now
    return { min: l, max: l, sure: true }
  }
  return { min: s.cacheAt + MIN_TTL - now, max: s.cacheAt + MAX_TTL - now, sure: false }
}
const ttlLabel = (s: Snap) =>
  s.ttlSure
    ? `TTL ${s.ttlMs === MAX_TTL ? '1 h' : '5 min'} (z pliku transkryptu)`
    : 'TTL nieznany: 5 min albo 1 h'

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

// Rate limits belong to the whole account, so every chat shares one file: whichever chat last
// heard a fresh reading from the API writes it, and every other chat adopts it when it is newer
// than its own (on entering the chat and every few seconds after).
const limitsFile = async ($: any): Promise<string> =>
  (await dirOf($)).replace(/\/sessions$/, '/limits.json')

const publishLimits = async ($: any) => {
  try {
    const s = await read($, snap)
    if (s.limits.length === 0 || !s.limitsAt) return
    await $.fs.write(await limitsFile($), JSON.stringify({ limits: s.limits, at: s.limitsAt }))
  } catch {}
}

const pullLimits = async ($: any) => {
  try {
    const p = JSON.parse(await $.fs.read(await limitsFile($)))
    const s = await read($, snap)
    if (Array.isArray(p.limits) && p.limits.length > 0 && p.at > (s.limitsAt ?? 0)) {
      await update($, snap, x => ({ ...x, limits: p.limits, limitsAt: p.at }))
    }
  } catch {}
}

// The engine's cost counter restarts with the process. cumUsd keeps a running total across
// restarts: each change of the engine's figure adds the difference (or the whole figure, when
// it dropped, i.e. after a restart). The previous total is read back from this chat's file.
let runBase: number | undefined

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
      // "since now": the engine's figure minus what it read when this module started
      if (runBase === undefined || usd < runBase) runBase = usd < (runBase ?? 0) ? 0 : usd
      return { ...s, cumUsd: cum0 + delta, lastUsd: usd, sinceUsd: Math.max(0, usd - runBase) }
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
    const cl0 = cacheLeft(s)
    if (cl0) {
      if (cl0.sure) parts.push(cl0.min > 0 ? `⏱ ${clock(cl0.min)}` : 'cache wygasł')
      else if (cl0.min > 0) parts.push(`⏱ ${clock(cl0.min)}–${clock(cl0.max)}`)
      else if (cl0.max > 0) parts.push(`⏱ maks ${clock(cl0.max)}`)
      else parts.push('cache wygasł')
    }
    const total = s.cumUsd ?? s.usd
    if (total !== undefined) parts.push(`$${total.toFixed(2)}`)
    if (parts.length) $.ui.status(parts.join(' · '))
    await $.fs.write(`${await dirOf($)}/${id}.json`, JSON.stringify({ ...s, id, cwd, at: Date.now() }))
  } catch {}
}

// The transcript keeps each reply's cache writes split by TTL (ephemeral_1h / ephemeral_5m), which
// the engine does not pass to mods. It lives at <home>/.claude/projects/<cwd, non-alphanumerics as '-'>/<id>.jsonl.
// $.fs.read refuses files over 4 MiB and transcripts pass that, so PowerShell reads only the file's
// last 4 MiB and prints "<ttl ms>|<last cache use, ms>" (either may be empty).
// Only main-thread assistant rows count: tool results and request blobs can quote the same field
// names as text. The newest write gives the TTL (1h only -> 1 h, 5m only -> 5 min, both -> 5 min,
// the shorter); the newest row that read or wrote the cache gives when the entry was last touched.
const TAIL_SCRIPT = [
  'param([string]$P)',
  `$f=[System.IO.File]::Open($P,'Open','Read','ReadWrite');try{$n=[int][math]::Min($f.Length,4MB);[void]$f.Seek(-$n,'End');$b=New-Object byte[] $n;$g=$f.Read($b,0,$n)}finally{$f.Dispose()}`,
  `$L=[Text.Encoding]::UTF8.GetString($b,0,$g).Split([char]10);$ttl=$null;$at=$null`,
  `for($i=$L.Count-1;$i -ge 0;$i--){$ln=$L[$i]`,
  `if($ln.Length -gt 2000000 -or -not $ln.Contains('"type":"assistant","uuid":"') -or -not $ln.Contains('cache_creation')){continue}`,
  `try{$o=$ln|ConvertFrom-Json}catch{continue};if($o.isSidechain){continue};$u=$o.message.usage;if(-not $u){continue}`,
  `$r=[int64]$u.cache_read_input_tokens;$c=[int64]$u.cache_creation_input_tokens`,
  `if($null -eq $at -and ($r+$c) -gt 0 -and $o.timestamp){$at=([datetimeoffset]$o.timestamp).ToUnixTimeMilliseconds()}`,
  `if($null -eq $ttl -and $c -gt 0 -and $u.cache_creation){$h=[int64]$u.cache_creation.ephemeral_1h_input_tokens;$m=[int64]$u.cache_creation.ephemeral_5m_input_tokens;if($h -gt 0 -or $m -gt 0){$ttl=if($h -gt 0 -and $m -eq 0){3600000}else{300000}}}`,
  `if($null -ne $at -and $null -ne $ttl){break}}`,
  `"$ttl|$at"`,
].join('\n')

let scriptWritten = false
const readTranscript = async ($: any): Promise<{ ttl?: number; at?: number }> => {
  let home = ''
  try { home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '' } catch {}
  const id: string = await $.session.id()
  const cwd: string = await $.session.cwd()
  const dir = cwd.replace(/[^A-Za-z0-9-]/g, '-')
  const path = `${home.replace(/\\/g, '/')}/.claude/projects/${dir}/${id}.jsonl`
  // a script file with the path as an argument: piping the script on stdin did not reach PowerShell
  const script = `${home.replace(/\\/g, '/')}/.claude/usage-monitor/tail-ttl.ps1`
  if (!scriptWritten) { await $.fs.write(script, TAIL_SCRIPT); scriptWritten = true }
  const { exitCode, stdout, stderr } = await $.process.run(
    ['powershell', '-NoProfile', '-NonInteractive', '-File', script, path],
    { timeoutMs: 20_000 },
  )
  if (exitCode !== 0) throw new Error(`powershell exit ${exitCode}: ${String(stderr).trim().slice(0, 200)}`)
  const [t, a] = String(stdout).trim().split('|')
  return { ttl: t ? Number(t) : undefined, at: a ? Number(a) : undefined }
}

// Applies what the file says: a known TTL is shown as such, an unknown one as the 5 min - 1 h range.
// One read at a time, and never awaited by a hook: the read takes a second or two.
let tBusy = false
const applyTranscript = async ($: any) => {
  if (tBusy) return
  tBusy = true
  try {
    const { ttl, at } = await readTranscript($)
    await update($, snap, s => ({
      ...s,
      cacheAt: at ?? s.cacheAt,
      ttlMs: ttl,
      ttlSure: ttl !== undefined,
      ttlSrc: ttl !== undefined ? 'api' : undefined,
      ttlErr: undefined,
    }))
    await publish($)
  } catch (err) {
    // the reason the file could not be read, kept in the state file where it can be seen
    scriptWritten = false // the script file may be what went missing: write it again next time
    try {
      await update($, snap, s => ({ ...s, ttlErr: String((err as any)?.message ?? err) }))
      await publish($)
    } catch {}
  } finally {
    tBusy = false
  }
}
// One read 2 s after a turn ends (the last reply may reach the file a moment after turn.complete),
// and one every 30 s while a turn runs, so a long turn does not leave an old "last cache use".
let recheckAt = 0
let turnActive = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-monitor',
      description: 'Open the live usage / context / cache pane',
    })
    void $.ui.open({ id: PANE, title: 'Usage' })
    stopTick?.()
    let beats = 0
    stopTick = $.clock.every(1000, () => {
      void update($, tick, n => n + 1)
      if (++beats % 3 === 0) void pullLimits($)
      if (recheckAt && Date.now() >= recheckAt) { recheckAt = 0; void applyTranscript($) }
      if (turnActive && beats % 30 === 0) void applyTranscript($)
      // keep the status-line countdown and the window's file fresh between turns
      if (beats % 10 === 0) void read($, snap).then(s => { if (s.cacheAt) return publish($) })
    })
    await pullLimits($)
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
    void applyTranscript($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, snap, s => ({
      ...s,
      tokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      limits: e.rateLimits.length > 0 ? e.rateLimits.map(r => ({ ...r })) : s.limits,
      limitsAt: e.rateLimits.length > 0 ? Date.now() : s.limitsAt,
      usd: e.cost?.usd,
    }))
    await publishLimits($)
    await publish($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (!e.agentId) turnActive = false
    if (u && !e.agentId) {
      // until the file is read, the turn's end stands in for the last cache use
      if ((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) > 0) {
        await update($, snap, s => ({ ...s, cacheAt: Date.now() }))
      }
      recheckAt = Date.now() + 2000
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

  on('prompt.submit', async ($, e, next) => {
    turnActive = true
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

    const cl = cacheLeft(s)
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
            {cl && (
              <Box flexDirection="column">
                {cl.sure ? (
                  <Text color={cl.min > MIN_TTL ? 'green' : cl.min > 0 ? 'yellow' : 'red'}>
                    {cl.min > 0 ? `cache ważny jeszcze ${clock(cl.min)}` : 'cache wygasł – następna odpowiedź zapisze kontekst od nowa'}
                  </Text>
                ) : cl.min > 0 ? (
                  <Text color="green">cache pewny jeszcze {clock(cl.min)} · najdłużej {clock(cl.max)}</Text>
                ) : cl.max > 0 ? (
                  <Text color="yellow">5 min minęło, cache może jeszcze żyć najdłużej {clock(cl.max)}</Text>
                ) : (
                  <Text color="red">cache wygasł – następna odpowiedź zapisze kontekst od nowa</Text>
                )}
                <Text dimColor>{ttlLabel(s)}</Text>
              </Box>
            )}
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
            <Text dimColor>od teraz (to uruchomienie): ${(s.sinceUsd ?? 0).toFixed(2)}</Text>
          </Box>
        )}
        {s.last && <Text dimColor>{s.last.model}</Text>}
      </Box>
    )
  })
}
