import { NextResponse } from 'next/server'
import { getScan, saveScan, addLog } from '@/lib/store'
import { CHUNK_SECONDS } from '@/lib/models'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'
import { isMinuteFinderRunning, stopAndWaitMinuteFinder } from '@/lib/gemini-minute-finder'
import { loadStudioUserConfig } from '@/lib/studio-settings'

export const runtime = 'nodejs'

/** Confirm the movie trim window (or the full movie).
 *  Logical 1-minute slots cover ONLY the confirmed range; all reported movie
 *  timestamps stay ABSOLUTE to the ORIGINAL movie (the scheduler adds the trim offset). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  if (!scan.movieDuration) return NextResponse.json({ error: 'Upload a movie first' }, { status: 400 })
  if (scan.status === 'scanning' || scan.status === 'verifying') {
    return NextResponse.json({ error: 'Cannot change the trim while a scan is running' }, { status: 409 })
  }
  // A Gemini Minute Finder run on the OLD trim range is stale now — stop it
  // before the chunk layout is reset (the dispatcher below starts a fresh run).
  if (isMinuteFinderRunning(id)) await stopAndWaitMinuteFinder(id, 'trim range badla', 10_000)

  const dur = scan.movieDuration
  const body = (await req.json().catch(() => ({}))) as { start?: number; end?: number }
  let start = Number.isFinite(Number(body.start)) ? Number(body.start) : 0
  let end = Number.isFinite(Number(body.end)) ? Number(body.end) : dur
  start = Math.min(Math.max(0, start), dur)
  end = Math.min(Math.max(start, end), dur)
  if (end - start < 1) return NextResponse.json({ error: 'Trim range must be at least 1 second' }, { status: 400 })

  const isFull = start <= 0.01 && end >= dur - 0.01
  scan.movieTrimStart = isFull ? undefined : start
  scan.movieTrimEnd = isFull ? undefined : end
  scan.awaitingTrim = false

  const session = await getSession()
  const owner = session?.username || scan.ownerUsername || 'admin'
  await loadStudioUserConfig(owner)
  scan.chunkScanEngine = 'studio'
  scan.verifierEnabled = false

  const rangeDur = end - start
  const count = Math.ceil(rangeDur / CHUNK_SECONDS)
  scan.chunkCount = count
  scan.chunks = Array.from({ length: count }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
  // Fresh chunk layout — reset any per-minute chunk states from a previous trim.
  if (scan.shortSegments) {
    for (const seg of scan.shortSegments) {
      seg.chunks = []
      if (seg.status !== 'pending') seg.status = 'pending'
    }
  }
  scan.matches = []
  scan.candidateGroups = []
  scan.status = 'ready'
  scan.chunkingProgress = 100
  addLog(
    scan,
    'info',
    `Trim confirmed (${isFull ? `FULL movie ${fmtDur(dur)}` : `${fmtDur(start)} → ${fmtDur(end)}`}) — Gemini Studio parallel window mode (${count} logical 1-min slots)`,
  )
  saveScan(scan)

  // AUTO MINUTE FINDER trigger: trim confirm hone ke baad, agar short bhi
  // uploaded hai → user ke toggle ke hisaab se:
  //   gemini     → Gemini Minute Finder (trimmed movie copy → 20-min windows → auto chunk scan)
  //   twelvelabs → merge → upload → index → Pegasus pipeline (old flow, fire-and-forget)
  //   off        → kuch nahi, manual Start
  try {
    if (pipelineReady(scan)) {
      await dispatchMinuteFinder(id, session ? { username: session.username, role: session.role } : null)
    }
  } catch (err) {
    console.error('[trim] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
  }

  return NextResponse.json({ ok: true, chunkCount: count, trimStart: scan.movieTrimStart ?? 0, trimEnd: scan.movieTrimEnd ?? dur })
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`
}
