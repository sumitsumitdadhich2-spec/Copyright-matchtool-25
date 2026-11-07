'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  Copy,
  CornerDownLeft,
  Globe,
  Keyboard,
  Loader2,
  MousePointerClick,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  Video,
} from 'lucide-react'
import type { PublicStudioSettings } from '@/lib/studio-settings'
import type { YtControllerSnapshot } from '@/lib/yt-studio-automation'
import type { ParallelScanLiveSnapshot, ParallelWindowState } from '@/lib/studio-parallel-manager'
import {
  buildParallelWindowsFromMinuteInput,
  formatParallelTimecode,
} from '@/lib/studio-window-planner'
import type { Scan } from '@/lib/types'

interface YtStudioPanelProps {
  studio?: PublicStudioSettings
  scanId?: string | null
  scan?: Scan | null
  onRefresh?: () => void
}

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function shortModelBadge(modelName: string | null | undefined): string {
  const raw = (modelName || '').toLowerCase()
  if (raw.includes('argon')) return 'Argon'
  if (raw.includes('3.6')) return '3.6'
  if (raw.includes('3.1-pro')) return '3.1 Pro'
  if (raw.includes('3-pro')) return '3 Pro'
  if (raw.includes('2.5-pro')) return '2.5 Pro'
  if (raw.includes('3-flash')) return '3 Flash'
  if (raw.includes('3.1-flash')) return '3.1 Lite'
  if (raw.includes('2.5-flash-lite')) return '2.5 Lite'
  if (raw.includes('2.5-flash')) return '2.5 Flash'
  return '3.8'
}

function uploadBadgeStyle(status: string): string {
  switch (status) {
    case 'READY':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
    case 'UPLOADING':
    case 'EXTRACTING':
      return 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 animate-pulse'
    case 'FAILED':
      return 'bg-red-500/25 text-red-300 border-red-500/50'
    case 'STOPPED':
      return 'bg-zinc-700/50 text-zinc-300 border-zinc-600'
    case 'QUEUED':
    default:
      return 'bg-amber-500/15 text-amber-300 border-amber-500/35'
  }
}

export function YtStudioPanel({ studio, scanId, scan, onRefresh }: YtStudioPanelProps) {
  const [snap, setSnap] = useState<YtControllerSnapshot | null>(null)
  const [parallelSnap, setParallelSnap] = useState<ParallelScanLiveSnapshot | null>(null)
  const [cookieText, setCookieText] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [typeText, setTypeText] = useState('')
  const [navUrl, setNavUrl] = useState('https://studio.youtube.com')
  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState(false)
  const [visibility, setVisibility] = useState<'unlisted' | 'private'>(
    studio?.ytVisibility ?? 'unlisted',
  )
  const [autoDeleteAtEnd, setAutoDeleteAtEnd] = useState<boolean>(
    studio?.ytAutoDeleteAtEnd ?? true,
  )
  const [uploadConcurrency, setUploadConcurrency] = useState<number>(
    studio?.ytUploadConcurrency ?? 3,
  )
  const [clickMarker, setClickMarker] = useState<{ x: number; y: number } | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    if (!studio) return
    setVisibility(studio.ytVisibility || 'unlisted')
    setAutoDeleteAtEnd(studio.ytAutoDeleteAtEnd ?? true)
    setUploadConcurrency(studio.ytUploadConcurrency || 3)
  }, [studio?.ytVisibility, studio?.ytAutoDeleteAtEnd, studio?.ytUploadConcurrency])

  // Poll / SSE stream for YouTube Studio live snapshot + current scan's parallel window upload state
  useEffect(() => {
    let active = true
    const qs = scanId ? `?target=yt&scanId=${encodeURIComponent(scanId)}` : '?target=yt'
    const es = new EventSource(`/api/studio/stream${qs}`)
    es.onmessage = (ev) => {
      if (!active) return
      try {
        const parsed = JSON.parse(ev.data)
        if (parsed?.ytSnapshot) {
          setSnap(parsed.ytSnapshot)
          if (parsed.ytSnapshot.currentUrl) {
            setNavUrl(parsed.ytSnapshot.currentUrl)
          }
        }
        if (parsed?.parallelSnapshot) {
          setParallelSnap(parsed.parallelSnapshot)
        }
      } catch {
        // ignore parse errors
      }
    }
    return () => {
      active = false
      es.close()
    }
  }, [scanId])

  async function callYtControl(payload: Record<string, unknown>, label: string) {
    setBusyAction(label)
    setErrorMsg(null)
    setStatusMsg(null)
    try {
      const res = await fetch('/api/studio/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId: scanId || undefined,
          ...payload,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error || `Failed: ${label}`)
        return null
      }
      if (data.ytSnapshot) {
        setSnap(data.ytSnapshot)
      }
      if (data.parallelSnapshot) {
        setParallelSnap(data.parallelSnapshot)
      }
      if (data.message) {
        setStatusMsg(String(data.message))
      } else if (data.ytUrl) {
        setStatusMsg(`Uploaded clip -> ${data.ytUrl}`)
      }
      onRefresh?.()
      return data
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSaveCookies() {
    if (!cookieText.trim()) return
    const res = await callYtControl(
      { action: 'yt_save_cookies', cookiesJson: cookieText },
      'save_cookies',
    )
    if (res) {
      setCookieText('')
      setStatusMsg(`Saved ${res.cookieCount || 0} YouTube Studio cookies (AES-256-GCM encrypted).`)
    }
  }

  async function handleClearCookies() {
    await callYtControl({ action: 'yt_clear_cookies' }, 'clear_cookies')
    setStatusMsg('Cleared YouTube Studio cookies and channel lock.')
  }

  async function handleSaveSettings(next: {
    ytVisibility?: 'unlisted' | 'private'
    ytAutoDeleteAtEnd?: boolean
    ytUploadConcurrency?: number
  }) {
    await callYtControl(
      {
        action: 'yt_save_settings',
        ytVisibility: next.ytVisibility ?? visibility,
        ytAutoDeleteAtEnd: next.ytAutoDeleteAtEnd ?? autoDeleteAtEnd,
        ytUploadConcurrency: next.ytUploadConcurrency ?? uploadConcurrency,
      },
      'save_settings',
    )
  }

  function handleScreenClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!snap?.assistMode) return
    const targetEl = imgRef.current || e.currentTarget
    const rect = targetEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const xRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const yRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    setClickMarker({ x: xRatio * 100, y: yRatio * 100 })
    setTimeout(() => setClickMarker(null), 700)
    void callYtControl({ action: 'yt_click', xRatio, yRatio }, 'click')
  }

  const isAssist = Boolean(snap?.assistMode)
  const loginStatus = studio?.ytLastLoginStatus ?? 'untested'
  const lockedChannel =
    studio?.ytChannelHandle ||
    snap?.channelHandle ||
    studio?.ytChannelId ||
    snap?.channelId ||
    null

  const effectiveMinuteInput = (
    parallelSnap?.minuteInput ||
    scan?.studioMinuteInput ||
    ''
  ).trim()

  const effectiveMovieDurationSec = useMemo(() => {
    const cands = [
      parallelSnap?.movieDurationSec,
      scan?.movieDuration,
      scan?.movie360p?.durationSec,
    ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
    return cands.length > 0 ? Math.min(...cands) : null
  }, [parallelSnap?.movieDurationSec, scan?.movieDuration, scan?.movie360p?.durationSec])

  const previewWindows = useMemo(() => {
    if (!effectiveMinuteInput) return []
    return buildParallelWindowsFromMinuteInput(
      effectiveMinuteInput,
      effectiveMovieDurationSec && effectiveMovieDurationSec > 0
        ? Math.floor(effectiveMovieDurationSec)
        : undefined,
    )
  }, [effectiveMinuteInput, effectiveMovieDurationSec])

  const scanWindows: ParallelWindowState[] = useMemo(
    () => parallelSnap?.windows ?? [],
    [parallelSnap?.windows],
  )

  const queueWaitReason = useMemo(() => {
    if (
      scan?.pipelineStage === 'waiting_chunk_ticket' &&
      scan?.waitingForTicket &&
      scan.waitingForTicket !== scan.chunkTicket
    ) {
      return `Chunk windows ke liye wait (My Ticket #${scan.chunkTicket ?? '?'} — Waiting for Ticket #${scan.waitingForTicket}${
        scan.waitingForScanTitle ? `: ${scan.waitingForScanTitle}` : ''
      })`
    }
    return null
  }, [scan?.pipelineStage, scan?.chunkTicket, scan?.waitingForTicket, scan?.waitingForScanTitle])

  const uploadStats = useMemo(() => {
    let ready = 0
    let uploading = 0
    let failed = 0
    let queued = 0
    for (const w of scanWindows) {
      if (w.ytUploadStatus === 'READY' || w.ytUrl) ready++
      else if (w.ytUploadStatus === 'UPLOADING' || w.ytUploadStatus === 'EXTRACTING') uploading++
      else if (w.ytUploadStatus === 'FAILED') failed++
      else queued++
    }
    return { ready, uploading, failed, queued, total: scanWindows.length }
  }, [scanWindows])

  return (
    <div className="rounded-xl border border-rose-500/35 bg-zinc-950/90 p-4 space-y-4 shadow-lg">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300">
            <Video className="size-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              YouTube Studio — Clip Uploader &amp; Login Assist
              <span className="rounded bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 font-mono text-[10px] text-rose-300">
                Unlisted / Draft / Checking = Ready
              </span>
            </h3>
            <p className="text-[11px] text-zinc-400">
              Uploads extracted 5-min window clips to your test YouTube channel and attaches{' '}
              <code className="font-mono">https://youtu.be/...</code> links in AI Studio (Unlisted, Draft &amp; Checking states work immediately)
            </p>
          </div>
        </div>

        {/* Status Badges */}
        <div className="flex flex-wrap items-center gap-1.5">
          {studio?.hasYtCookies ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/40 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
              <ShieldCheck className="size-3.5" />
              YT Cookies ({studio.ytCookieCount})
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/40 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
              No YT Cookies
            </span>
          )}

          {loginStatus === 'logged_in' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2.5 py-0.5 text-[11px] font-mono text-emerald-200">
              <CheckCircle2 className="size-3" />
              Logged In {lockedChannel ? `· ${lockedChannel}` : ''}
            </span>
          )}
          {loginStatus === 'logged_out' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 border border-red-500/40 px-2.5 py-0.5 text-[11px] font-mono text-red-200">
              Logged Out
            </span>
          )}
          {lockedChannel && loginStatus !== 'logged_in' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 border border-zinc-700 px-2.5 py-0.5 text-[11px] font-mono text-zinc-300">
              Locked: {lockedChannel}
            </span>
          )}
        </div>
      </div>

      {/* Top 2-column Config: Cookies on left, Uploader Settings & Actions on right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: YouTube Studio Cookies */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
              <Cookie className="size-3.5 text-rose-400" />
              YouTube Studio Cookies (Cookie-Editor JSON)
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => callYtControl({ action: 'yt_test_login' }, 'test_login')}
                className="rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 px-2.5 py-1 text-[11px] font-medium text-rose-200 disabled:opacity-50"
              >
                {busyAction === 'test_login' ? 'Testing...' : 'Test Login'}
              </button>
              {studio?.hasYtCookies && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={handleClearCookies}
                  className="rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 disabled:opacity-50"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <textarea
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
            rows={3}
            placeholder="Paste Cookie-Editor JSON array exported from studio.youtube.com or youtube.com..."
            className="w-full rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200 focus:outline-none focus:border-rose-500/50"
          />

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-zinc-400">
              Encrypted with AES-256-GCM. Use a dedicated empty/test YouTube channel.
            </span>
            <button
              type="button"
              disabled={busyAction !== null || !cookieText.trim()}
              onClick={handleSaveCookies}
              className="rounded bg-rose-500 hover:bg-rose-400 px-3 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-40"
            >
              {busyAction === 'save_cookies'
                ? 'Saving...'
                : studio?.hasYtCookies
                  ? 'Replace Cookies'
                  : 'Save Encrypted'}
            </button>
          </div>
        </div>

        {/* Right: Visibility, Auto-Delete, Upload Concurrency & Manual Actions */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Default Upload Visibility
              </label>
              <select
                value={visibility}
                onChange={(e) => {
                  const v = e.target.value === 'private' ? 'private' : 'unlisted'
                  setVisibility(v)
                  void handleSaveSettings({ ytVisibility: v })
                }}
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200"
              >
                <option value="unlisted">Unlisted (Required for AI Studio link)</option>
                <option value="private">Private</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Parallel YT Uploads (1–5)
              </label>
              <input
                type="number"
                min={1}
                max={5}
                value={uploadConcurrency}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(5, Number(e.target.value) || 3))
                  setUploadConcurrency(n)
                  void handleSaveSettings({ ytUploadConcurrency: n })
                }}
                className="w-full rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs font-mono text-zinc-200"
              />
            </div>
          </div>

          <label className="flex items-center justify-between gap-2 text-xs text-zinc-200 cursor-pointer pt-1">
            <div>
              <span className="font-medium">Auto-delete all channel videos when scan finishes</span>
              <p className="text-[10px] text-zinc-400">
                Runs Select All &rarr; Delete forever on locked channel{' '}
                {lockedChannel || '(locked on first login)'}
              </p>
            </div>
            <input
              type="checkbox"
              checked={autoDeleteAtEnd}
              onChange={(e) => {
                const next = e.target.checked
                setAutoDeleteAtEnd(next)
                void handleSaveSettings({ ytAutoDeleteAtEnd: next })
              }}
              className="h-4 w-4 accent-rose-500 cursor-pointer"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-zinc-800">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => callYtControl({ action: 'yt_upload_test' }, 'upload_test')}
              className="inline-flex items-center gap-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 px-2.5 py-1 text-[11px] font-medium text-cyan-200 disabled:opacity-50"
            >
              <Upload className="size-3.5" />
              {busyAction === 'upload_test' ? 'Uploading test clip...' : 'Test Upload 1 Clip'}
            </button>

            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                callYtControl({ action: 'yt_check_content', waitForSdReady: false }, 'check_content')
              }
              className="inline-flex items-center gap-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-medium text-emerald-200 disabled:opacity-50"
              title="Close 'Video processing' popup, go to YouTube Studio Content page, check upload progress, and extract all video links"
            >
              <CheckCircle2 className="size-3.5" />
              {busyAction === 'check_content'
                ? 'Checking Content...'
                : 'Close Popup & Check Content Links'}
            </button>

            {!confirmCleanupOpen ? (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => setConfirmCleanupOpen(true)}
                className="inline-flex items-center gap-1.5 rounded bg-red-500/15 hover:bg-red-500/25 border border-red-500/35 px-2.5 py-1 text-[11px] font-medium text-red-300 disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
                Delete all videos from channel now
              </button>
            ) : (
              <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-500/50 rounded px-2 py-1">
                <span className="text-[11px] text-red-200 font-medium">
                  Delete ALL videos on {lockedChannel || 'locked channel'}?
                </span>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => {
                    setConfirmCleanupOpen(false)
                    void callYtControl({ action: 'yt_cleanup_now' }, 'cleanup_now')
                  }}
                  className="rounded bg-red-500 hover:bg-red-400 px-2 py-0.5 text-[10px] font-bold text-zinc-950"
                >
                  Confirm Delete Forever
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCleanupOpen(false)}
                  className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Live Channel Content Progress & Extracted Video Links */}
      {snap?.contentProgress && snap.contentProgress.items.length > 0 && (
        <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/20 p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold text-emerald-200 flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-emerald-400" />
              Channel Content Progress:{' '}
              <span className="font-mono">
                {snap.contentProgress.uploadedCount}/
                {snap.contentProgress.expectedCount || snap.contentProgress.uploadedCount} Uploaded
              </span>{' '}
              ·{' '}
              <span className="font-mono text-emerald-300">
                {snap.contentProgress.readyCount}/
                {snap.contentProgress.expectedCount || snap.contentProgress.uploadedCount} Ready
                (Unlisted / Draft / Checking)
              </span>
              {snap.contentProgress.processingCount > 0 && (
                <span className="font-mono text-amber-300">
                  · {snap.contentProgress.processingCount} Processing SD...
                </span>
              )}
              {snap.contentProgress.claimedCount > 0 && (
                <span className="font-mono text-cyan-300">
                  · {snap.contentProgress.claimedCount} Claimed (Link OK)
                </span>
              )}
            </span>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                callYtControl({ action: 'yt_check_content', waitForSdReady: true }, 'check_content')
              }
              className="rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-mono text-emerald-200"
            >
              Refresh Content &amp; Wait SD
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-36 overflow-y-auto">
            {snap.contentProgress.items.map((item) => (
              <div
                key={item.videoId}
                className="flex items-center justify-between gap-2 rounded bg-zinc-900/90 border border-zinc-800 px-2.5 py-1 text-[11px] font-mono"
              >
                <div className="truncate">
                  <span className="text-zinc-200 font-semibold">{item.title}</span>{' '}
                  <span className={item.isReady ? 'text-emerald-400' : 'text-amber-300'}>
                    ({item.visibility}
                    {item.hasClaim ? ' · Claimed' : ''})
                  </span>
                  <div className="text-cyan-300 truncate">{item.ytUrl}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(item.ytUrl).catch(() => {})
                    setStatusMsg(`Copied link: ${item.ytUrl}`)
                  }}
                  className="shrink-0 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-200"
                >
                  Copy
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {statusMsg && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300 flex items-center justify-between">
          <span>{statusMsg}</span>
          <button
            type="button"
            onClick={() => setStatusMsg(null)}
            className="text-[10px] text-emerald-400 hover:text-emerald-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {errorMsg && (
        <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="size-3.5 shrink-0" />
            {errorMsg}
          </span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-[10px] text-red-400 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Interactive Browser Control Bar (UPAR BUTTONS) + Live Screen (BEECH ME) + Step Logs (NICHE) */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 overflow-hidden">
        {/* UPAR BUTTONS */}
        <div className="p-2.5 border-b border-zinc-800 bg-zinc-950 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  callYtControl({ action: 'yt_assist_toggle', enabled: !isAssist }, 'assist_toggle')
                }
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium border ${
                  isAssist
                    ? 'bg-emerald-500/25 text-emerald-200 border-emerald-500/50'
                    : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700'
                }`}
              >
                <MousePointerClick className="size-3.5" />
                {isAssist ? 'Login Assist (ON)' : 'Login Assist (Interactive)'}
              </button>

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => callYtControl({ action: 'yt_verify_next' }, 'verify_next')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 border border-cyan-500/40"
                title="Click 'Next' on YouTube Studio 'Verify it's you' dialog and switch to the Google verification popup window"
              >
                <ShieldCheck className="size-3.5" />
                Verify &ldquo;Next&rdquo; / Switch Popup
              </button>

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  callYtControl({ action: 'yt_check_content', waitForSdReady: false }, 'check_content')
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40"
                title="Close 'Video processing' popup, open Content list, and grab video links"
              >
                <CheckCircle2 className="size-3.5" />
                Close Popup &amp; Check Content
              </button>

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => callYtControl({ action: 'yt_save_session' }, 'save_session')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40"
                title="Save cookies directly from this live YouTube Studio browser"
              >
                <Cookie className="size-3.5" />
                Save Session Cookies
              </button>

              {snap?.status === 'paused' ? (
                <button
                  type="button"
                  onClick={() => callYtControl({ action: 'yt_resume' }, 'resume')}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                >
                  <Play className="size-3" />
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => callYtControl({ action: 'yt_pause' }, 'pause')}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-zinc-800 text-zinc-300 border border-zinc-700"
                >
                  <Pause className="size-3" />
                  Pause
                </button>
              )}

              <button
                type="button"
                onClick={() => callYtControl({ action: 'yt_stop' }, 'stop')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-red-500/20 text-red-300 border border-red-500/40"
              >
                <Square className="size-3" />
                Stop
              </button>
            </div>

            <span className="text-[11px] font-mono text-zinc-400">
              Status: <strong className="text-zinc-200 uppercase">{snap?.status || 'idle'}</strong> ·{' '}
              {snap?.currentStep || 'Idle'}
            </span>
          </div>

          {/* Type / Enter / Navigate row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 flex-1 min-w-[200px]">
              <input
                type="text"
                value={typeText}
                onChange={(e) => setTypeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typeText) {
                    e.preventDefault()
                    const t = typeText
                    setTypeText('')
                    void callYtControl({ action: 'yt_type', text: t }, 'type')
                  }
                }}
                placeholder="Type text into focused field..."
                className="flex-1 rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-xs text-zinc-200"
              />
              <button
                type="button"
                disabled={!typeText}
                onClick={() => {
                  const t = typeText
                  setTypeText('')
                  void callYtControl({ action: 'yt_type', text: t }, 'type')
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 border border-zinc-700 disabled:opacity-40"
              >
                <Keyboard className="size-3" />
                Type
              </button>
              <button
                type="button"
                onClick={() => callYtControl({ action: 'yt_key', key: 'Enter' }, 'key_enter')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 border border-zinc-700"
              >
                <CornerDownLeft className="size-3" />
                Enter
              </button>
            </div>

            <div className="flex items-center gap-1 flex-1 min-w-[220px]">
              <input
                type="text"
                value={navUrl}
                onChange={(e) => setNavUrl(e.target.value)}
                placeholder="https://studio.youtube.com"
                className="flex-1 rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-xs font-mono text-zinc-300"
              />
              <button
                type="button"
                onClick={() => callYtControl({ action: 'yt_navigate', url: navUrl }, 'navigate')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-200 border border-zinc-700"
              >
                <Globe className="size-3" />
                Go
              </button>
            </div>
          </div>
          {/* Open Tabs / Popup Switcher Bar (shows when Google Verify popup opens) */}
          {snap?.openTabs && snap.openTabs.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-zinc-800/80">
              <span className="text-[10px] font-mono uppercase tracking-wider text-amber-300 font-semibold">
                Open Browser Windows ({snap.openTabs.length}):
              </span>
              {snap.openTabs.map((t) => {
                const isGooglePopup = t.url.includes('accounts.google.com')
                return (
                  <button
                    key={t.index}
                    type="button"
                    onClick={() =>
                      callYtControl({ action: 'yt_switch_tab', tabIndex: t.index }, 'switch_tab')
                    }
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition ${
                      t.active
                        ? 'bg-rose-500/25 border-rose-400 text-rose-100 font-bold'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {t.index === 0 ? 'Tab 1: YT Studio' : `Popup #${t.index + 1}`}{' '}
                    {isGooglePopup ? '(Google Verify)' : ''} — {t.url.slice(0, 42)}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* BEECH ME LIVE SCREEN */}
        <div
          onClick={handleScreenClick}
          className={`relative aspect-[1366/820] w-full bg-zinc-950 flex items-center justify-center overflow-hidden ${
            isAssist ? 'cursor-crosshair' : 'cursor-default'
          }`}
        >
          {snap?.screenshotBase64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={snap.screenshotBase64}
              alt="YouTube Studio Live Browser"
              className="w-full h-full object-fill select-none"
            />
          ) : (
            <div className="text-center space-y-1 p-6">
              {busyAction ? (
                <Loader2 className="size-6 animate-spin text-rose-400 mx-auto" />
              ) : null}
              <p className="text-xs text-zinc-400">
                YouTube Studio browser is idle. Click <strong>Login Assist</strong> or{' '}
                <strong>Test Login</strong> to launch.
              </p>
            </div>
          )}

          {clickMarker && (
            <span
              style={{ left: `${clickMarker.x}%`, top: `${clickMarker.y}%` }}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 size-5 rounded-full border-2 border-rose-400 bg-rose-400/30 animate-ping"
            />
          )}
        </div>

        {/* NICHE STEP LOGS */}
        <div className="border-t border-zinc-800 bg-zinc-950/95 p-2.5 max-h-40 overflow-y-auto font-mono text-[11px] space-y-1">
          {snap?.logs && snap.logs.length > 0 ? (
            snap.logs.slice(0, 30).map((l, idx) => (
              <div key={`${l.ts}-${idx}`} className="flex items-start gap-2">
                <span className="text-zinc-500 shrink-0">
                  {new Date(l.ts).toTimeString().slice(0, 8)}
                </span>
                <span
                  className={
                    l.status === 'error'
                      ? 'text-red-400'
                      : l.status === 'warn'
                        ? 'text-amber-300'
                        : l.status === 'ok'
                          ? 'text-emerald-300'
                          : 'text-zinc-300'
                  }
                >
                  [{l.step}] {l.detail}
                </span>
              </div>
            ))
          ) : (
            <div className="text-zinc-500">No YouTube Studio logs yet.</div>
          )}
        </div>
      </div>

      {/* ========================================================================
          PER-SCAN WINDOW UPLOAD PREVIEW & ACTIVE / SAVED UPLOAD WINDOWS SECTION
          (Shared YT Browser Screen above, Separate Per-Scan Window Upload Control below)
          ======================================================================== */}
      {scanId && (previewWindows.length > 0 || scanWindows.length > 0) && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3.5 space-y-3">
          {/* 1. Window Preview (N Windows · Max 5:00 · no overlap) */}
          {previewWindows.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
                    Window Preview ({previewWindows.length} Windows · Max 5:00 · no overlap)
                  </span>
                  {effectiveMovieDurationSec && effectiveMovieDurationSec > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                      <CheckCircle2 className="w-3 h-3" />
                      All {previewWindows.length} windows within Movie Length (
                      {formatParallelTimecode(Math.floor(effectiveMovieDurationSec))})
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-mono text-zinc-400">
                  Minutes: <strong className="text-zinc-200">{effectiveMinuteInput}</strong>
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                {previewWindows.map((pw) => (
                  <span
                    key={pw.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-800 bg-zinc-900 text-zinc-200 text-[10px] font-mono"
                    title={`Run ${pw.runLabel} · Part ${pw.partIndex}/${pw.partsInRun} · Priority #${pw.priorityRank}`}
                  >
                    <strong className="text-cyan-400">#{pw.windowNumber}</strong>
                    <span>
                      {pw.startFormatted}–{pw.endFormatted}
                    </span>
                    <span className="text-zinc-500">({formatMmSs(pw.durationSec)})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 2. Active / Saved Scan Upload Windows (Per-Scan Status, Retry & Control) */}
          {scanWindows.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-200">
                    Active / Saved Upload Windows ({scanWindows.length} Windows · Max 5:00 each · no overlap)
                  </span>
                  <span className="rounded bg-emerald-500/15 border border-emerald-500/35 px-2 py-0.5 font-mono text-[10px] text-emerald-300">
                    Ready (Unlisted/Draft/Checking): {uploadStats.ready}/{uploadStats.total}
                  </span>
                  {uploadStats.uploading > 0 && (
                    <span className="rounded bg-cyan-500/15 border border-cyan-500/35 px-2 py-0.5 font-mono text-[10px] text-cyan-300">
                      Uploading: {uploadStats.uploading}
                    </span>
                  )}
                  {uploadStats.failed > 0 && (
                    <span className="rounded bg-red-500/15 border border-red-500/35 px-2 py-0.5 font-mono text-[10px] text-red-300">
                      Failed: {uploadStats.failed}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      callYtControl(
                        { action: 'yt_upload_all_windows', onlyFailedOrMissing: true },
                        'upload_all_missing',
                      )
                    }
                    className="inline-flex items-center gap-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 px-2.5 py-1 text-[10px] font-mono font-semibold text-cyan-200 disabled:opacity-50"
                    title="Upload all windows in this scan that do not have a YouTube link yet"
                  >
                    <Upload className="size-3" />
                    Upload Pending ({uploadStats.total - uploadStats.ready})
                  </button>

                  {uploadStats.failed > 0 && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        callYtControl(
                          { action: 'yt_upload_all_windows', onlyFailedOrMissing: true },
                          'retry_failed_uploads',
                        )
                      }
                      className="inline-flex items-center gap-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 px-2.5 py-1 text-[10px] font-mono font-semibold text-amber-200 disabled:opacity-50"
                    >
                      <RotateCcw className="size-3" />
                      Retry Failed ({uploadStats.failed})
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      callYtControl(
                        { action: 'yt_check_content', waitForSdReady: false },
                        'sync_content_links',
                      )
                    }
                    className="inline-flex items-center gap-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-2.5 py-1 text-[10px] font-mono font-semibold text-emerald-200 disabled:opacity-50"
                  >
                    <CheckCircle2 className="size-3" />
                    Sync Content (Unlisted/Draft/Checking)
                  </button>
                </div>
              </div>

              <div className="text-[10px] font-mono text-zinc-500 flex items-center justify-between">
                <span>
                  Scan: <strong className="text-zinc-300">{parallelSnap?.scanName || scan?.movieName || scanId}</strong>
                </span>
                <span>Queue Priority: Largest contiguous runs pulled first</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-80 overflow-y-auto pr-1">
                {scanWindows.map((win) => {
                  const upStatus = win.ytUrl ? 'READY' : win.ytUploadStatus || 'QUEUED'
                  const visBadge = win.ytVisibility || (win.ytUrl ? 'Unlisted' : null)
                  const subText = win.ytUrl
                    ? `${visBadge || 'Ready'} · ${win.ytUrl}`
                    : win.ytError
                      ? win.ytError
                      : queueWaitReason && win.status === 'QUEUED'
                        ? `${queueWaitReason} · ${shortModelBadge(win.modelName)}`
                        : `${win.ytStageText || win.stage || 'Queued'} · ${shortModelBadge(win.modelName)}`

                  return (
                    <div
                      key={`yt-up-${win.id}`}
                      className="rounded-lg border border-zinc-800/90 bg-zinc-950/90 px-3 py-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono font-bold text-zinc-100">
                            #{win.windowNumber}
                          </span>
                          <span className="font-mono text-cyan-300">
                            {win.startFormatted}–{win.endFormatted}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">
                            ({formatMmSs(win.durationSec)})
                          </span>
                          <span
                            className={`px-1.5 py-0.2 rounded border text-[9px] font-mono font-semibold uppercase ${uploadBadgeStyle(
                              upStatus,
                            )}`}
                          >
                            {upStatus === 'READY'
                              ? `READY (${visBadge || 'UNLISTED'})`
                              : upStatus}
                          </span>
                        </div>

                        <div className="mt-0.5 text-[10px] font-mono truncate">
                          {win.ytUrl ? (
                            <span className="text-emerald-300 font-medium">{subText}</span>
                          ) : win.ytError ? (
                            <span className="text-red-300">{subText}</span>
                          ) : (
                            <span className="text-zinc-400">{subText}</span>
                          )}
                        </div>
                      </div>

                      {/* Per-window upload controls: Copy Link, Stop Upload, Upload / Retry Upload */}
                      <div className="flex items-center gap-1 shrink-0">
                        {win.ytUrl && (
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard?.writeText(win.ytUrl || '').catch(() => {})
                              setStatusMsg(`Copied Window #${win.windowNumber} link: ${win.ytUrl}`)
                            }}
                            className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                            title={`Copy link: ${win.ytUrl}`}
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        )}

                        {(upStatus === 'UPLOADING' || upStatus === 'EXTRACTING') && (
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() =>
                              callYtControl(
                                {
                                  action: 'yt_stop_window_upload',
                                  windowId: win.id,
                                  windowNumber: win.windowNumber,
                                },
                                `yt_stop_${win.id}`,
                              )
                            }
                            className="p-1 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30"
                            title={`Stop Window #${win.windowNumber} upload`}
                          >
                            <Square className="w-3 h-3" />
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            callYtControl(
                              {
                                action: 'yt_upload_window',
                                windowId: win.id,
                                windowNumber: win.windowNumber,
                                forceUpload: true,
                              },
                              `yt_retry_${win.id}`,
                            )
                          }
                          className="p-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 disabled:opacity-50"
                          title={`Upload / Retry Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted})`}
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
