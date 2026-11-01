'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Cookie,
  CornerDownLeft,
  Globe,
  Keyboard,
  Loader2,
  MousePointerClick,
  Pause,
  Play,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  Video,
} from 'lucide-react'
import type { PublicStudioSettings } from '@/lib/studio-settings'
import type { YtControllerSnapshot } from '@/lib/yt-studio-automation'

interface YtStudioPanelProps {
  studio?: PublicStudioSettings
  scanId?: string | null
  onRefresh?: () => void
}

export function YtStudioPanel({ studio, scanId, onRefresh }: YtStudioPanelProps) {
  const [snap, setSnap] = useState<YtControllerSnapshot | null>(null)
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

  // Poll / SSE stream for YouTube Studio live snapshot
  useEffect(() => {
    let active = true
    const es = new EventSource('/api/studio/stream?target=yt')
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
      } catch {
        // ignore parse errors
      }
    }
    return () => {
      active = false
      es.close()
    }
  }, [])

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
                Unlisted Link Flow
              </span>
            </h3>
            <p className="text-[11px] text-zinc-400">
              Uploads extracted 5-min window clips to your dedicated test YouTube channel and attaches <code className="font-mono">https://youtu.be/...</code> links in AI Studio
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
            placeholder='Paste Cookie-Editor JSON array exported from studio.youtube.com or youtube.com...'
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
                Runs Select All &rarr; Delete forever on locked channel {lockedChannel || '(locked on first login)'}
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
    </div>
  )
}
