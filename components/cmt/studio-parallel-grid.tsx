'use client'

import React, { useState } from 'react'
import {
  Play,
  Pause,
  Square,
  RotateCcw,
  SkipForward,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Layers,
  Copy,
  Download,
  Maximize2,
  X,
  Cpu,
  HardDrive,
  FileText,
  FileCode,
  Sparkles,
} from 'lucide-react'
import type {
  ParallelScanLiveSnapshot,
  ParallelWindowState,
  ParallelWindowStatus,
  ParallelWorkerCardSnapshot,
} from '@/lib/studio-parallel-manager'

interface StudioParallelGridProps {
  parallelSnapshot: ParallelScanLiveSnapshot | null
  scanId?: string | null
  onActionCompleted?: (nextParallel: ParallelScanLiveSnapshot) => void
}

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

function statusBadgeStyle(status: ParallelWindowStatus | 'IDLE'): string {
  switch (status) {
    case 'DONE':
      return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
    case 'RUNNING':
    case 'VALIDATING':
      return 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
    case 'SETUP':
      return 'border-blue-500/40 bg-blue-500/15 text-blue-300'
    case '403_WAIT':
    case 'RETRYING':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-300'
    case 'NEEDS_ATTENTION':
      return 'border-rose-500/60 bg-rose-500/20 text-rose-200 animate-pulse'
    case 'FAILED':
      return 'border-red-500/40 bg-red-500/15 text-red-300'
    case 'STOPPED':
    case 'SKIPPED':
      return 'border-zinc-600/50 bg-zinc-800/60 text-zinc-400'
    case 'QUEUED':
    case 'IDLE':
    default:
      return 'border-zinc-700/60 bg-zinc-900/60 text-zinc-400'
  }
}

function shortModelBadge(modelName: string): string {
  if (/3\.8/i.test(modelName)) return '3.8 Flash'
  if (/3\.7/i.test(modelName)) return '3.7 Flash'
  if (/3\.6/i.test(modelName)) return '3.6 Flash'
  return modelName || '3.8 Flash'
}

export function StudioParallelGrid({
  parallelSnapshot,
  scanId,
  onActionCompleted,
}: StudioParallelGridProps) {
  const [minuteInput, setMinuteInput] = useState<string>(
    parallelSnapshot?.minuteInput ||
      '7,8,9,10,14,15,16,17,19,20,21,25-41,48-54,56,57,58,63-67,71-100',
  )
  const [concurrency, setConcurrency] = useState<number>(parallelSnapshot?.concurrency || 10)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null)
  const [reportTab, setReportTab] = useState<'txt' | 'json'>('txt')
  const [copiedReport, setCopiedReport] = useState(false)

  // Keep local inputs synced when parallelSnapshot initializes for the first time
  const initializedRef = React.useRef(false)
  React.useEffect(() => {
    if (parallelSnapshot && !initializedRef.current) {
      initializedRef.current = true
      if (parallelSnapshot.minuteInput) setMinuteInput(parallelSnapshot.minuteInput)
      if (parallelSnapshot.concurrency) setConcurrency(parallelSnapshot.concurrency)
    }
  }, [parallelSnapshot])

  const postParallelControl = async (payload: Record<string, unknown>, label: string) => {
    setBusyAction(label)
    setErrorMsg(null)
    try {
      const res = await fetch('/api/studio/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId: scanId || parallelSnapshot?.scanId || undefined,
          ...payload,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setErrorMsg(data.error || `Failed: ${label}`)
      } else if (data.parallelSnapshot) {
        onActionCompleted?.(data.parallelSnapshot as ParallelScanLiveSnapshot)
      }
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setBusyAction(null)
    }
  }

  const activeCount = parallelSnapshot?.activeWorkersCount ?? 0
  const maxConcurrency = parallelSnapshot?.concurrency ?? concurrency
  const doneCount = parallelSnapshot?.doneCount ?? 0
  const totalWindows = parallelSnapshot?.totalWindows ?? 0
  const queuedCount = parallelSnapshot?.queuedCount ?? 0
  const failedCount = parallelSnapshot?.failedCount ?? 0
  const needsAttentionCount = parallelSnapshot?.needsAttentionCount ?? 0
  const elapsedSec = parallelSnapshot?.elapsedSec ?? 0
  const workers = parallelSnapshot?.workers ?? []
  const windows = parallelSnapshot?.windows ?? []
  const mergedReport = parallelSnapshot?.mergedReport ?? null

  const selectedWorker: ParallelWorkerCardSnapshot | null =
    selectedWorkerId ? workers.find((w) => w.workerId === selectedWorkerId) || null : null

  const handleCopyReport = async () => {
    if (!mergedReport) return
    const content =
      reportTab === 'txt' ? mergedReport.formattedTxt : JSON.stringify(mergedReport, null, 2)
    try {
      await navigator.clipboard.writeText(content)
      setCopiedReport(true)
      setTimeout(() => setCopiedReport(false), 2000)
    } catch {
      /* ignore */
    }
  }

  const handleDownloadReport = (ext: 'txt' | 'json') => {
    if (!mergedReport) return
    const content =
      ext === 'txt' ? mergedReport.formattedTxt : JSON.stringify(mergedReport, null, 2)
    const blob = new Blob([content], {
      type: ext === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `parallel-window-scan-report.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/95 overflow-hidden">
      {/* Top Summary Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-semibold tracking-wide text-zinc-100 uppercase">
              Parallel Window Scan
            </span>
          </div>

          <span className="text-[11px] font-mono px-2.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-200">
            Active:{' '}
            <strong className="text-cyan-400">
              {activeCount}/{maxConcurrency}
            </strong>{' '}
            · Done:{' '}
            <strong className="text-emerald-400">
              {doneCount}/{totalWindows}
            </strong>{' '}
            · Queued: <strong className="text-amber-300">{queuedCount}</strong> · Failed:{' '}
            <strong className={failedCount > 0 ? 'text-red-400' : 'text-zinc-400'}>
              {failedCount}
            </strong>{' '}
            · Elapsed: <strong className="text-zinc-200">{formatMmSs(elapsedSec)}</strong>
          </span>

          {needsAttentionCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse">
              <AlertTriangle className="w-3 h-3" />
              NEEDS ATTENTION: {needsAttentionCount}
            </span>
          )}

          {parallelSnapshot && (
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-400">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800">
                <Cpu className="w-3 h-3 text-zinc-500" />
                RAM {parallelSnapshot.ramUsedPercent}%
              </span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800">
                <HardDrive className="w-3 h-3 text-zinc-500" />
                Disk {parallelSnapshot.freeDiskGb} GB
              </span>
              {parallelSnapshot.measuredTokenRate && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-300">
                  <Sparkles className="w-3 h-3" />
                  {parallelSnapshot.measuredTokenRate} tok/s
                </span>
              )}
            </div>
          )}
        </div>

        {/* Global Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {!parallelSnapshot?.active ? (
            <>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  postParallelControl(
                    {
                      action: 'start_parallel_scan',
                      minuteInput,
                      concurrency,
                      resumeExisting: false,
                    },
                    'start_parallel',
                  )
                }
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50"
              >
                <Play className="w-3 h-3" />
                {busyAction === 'start_parallel' ? 'Starting...' : 'Start Parallel Scan'}
              </button>

              {totalWindows > 0 && doneCount < totalWindows && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    postParallelControl(
                      {
                        action: 'start_parallel_scan',
                        minuteInput,
                        concurrency,
                        resumeExisting: true,
                      },
                      'resume_existing',
                    )
                  }
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
                  title="Resume without re-running already DONE windows"
                >
                  <Play className="w-3 h-3" />
                  Resume ({doneCount}/{totalWindows} done)
                </button>
              )}
            </>
          ) : (
            <>
              {parallelSnapshot.paused ? (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => postParallelControl({ action: 'resume_parallel' }, 'resume_all')}
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30"
                >
                  <Play className="w-3 h-3" />
                  Resume All
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => postParallelControl({ action: 'pause_parallel' }, 'pause_all')}
                  className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30"
                >
                  <Pause className="w-3 h-3" />
                  Pause All
                </button>
              )}

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => postParallelControl({ action: 'stop_parallel' }, 'stop_all')}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500/30"
              >
                <Square className="w-3 h-3" />
                Stop All
              </button>
            </>
          )}

          {(failedCount > 0 || needsAttentionCount > 0) && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() =>
                postParallelControl({ action: 'retry_failed_parallel' }, 'retry_failed')
              }
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40 hover:bg-amber-500/30 disabled:opacity-50"
            >
              <RotateCcw className="w-3 h-3" />
              Retry failed windows ({failedCount + needsAttentionCount})
            </button>
          )}
        </div>
      </div>

      {/* Config Bar: Movie Minutes Input + Concurrency */}
      <div className="px-4 py-2.5 border-b border-zinc-800/80 bg-zinc-900/40 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[260px] flex items-center gap-2">
          <label className="text-[11px] font-medium text-zinc-400 shrink-0">
            Movie Minutes:
          </label>
          <input
            type="text"
            value={minuteInput}
            onChange={(e) => setMinuteInput(e.target.value)}
            placeholder="7,8,9,10,14,15,16,17,19,20,21,25-41,48-54,56,57,58,63-67,71-100"
            className="flex-1 rounded bg-zinc-950 border border-zinc-800 px-2.5 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-cyan-500/50"
          />
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[11px] font-medium text-zinc-400">Concurrency:</label>
          <input
            type="number"
            min={1}
            max={20}
            value={concurrency}
            onChange={(e) => setConcurrency(Math.max(1, Math.min(20, Number(e.target.value) || 10)))}
            className="w-16 rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs font-mono text-zinc-200 text-center focus:outline-none focus:border-cyan-500/50"
          />
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              postParallelControl(
                { action: 'save_parallel_config', minuteInput, concurrency },
                'save_config',
              )
            }
            className="text-[11px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
          >
            {busyAction === 'save_config' ? 'Saving...' : 'Build / Preview Windows'}
          </button>
        </div>
      </div>

      {parallelSnapshot?.resourceWarning && (
        <div className="px-4 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-[11px] text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{parallelSnapshot.resourceWarning}</span>
        </div>
      )}

      {errorMsg && (
        <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/30 text-[11px] text-red-300 flex items-center justify-between">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-400 hover:text-red-200 text-[10px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Worker Cards Grid (10 isolated Chrome workers W01..W10) */}
      <div className="p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2.5 flex items-center justify-between">
          <span>Worker Browser Pool ({workers.length || maxConcurrency} Chrome Profiles)</span>
          <span className="text-[10px] font-normal text-zinc-500">
            Click any worker card to view large screenshot &amp; [Wxx] step logs (200 lines)
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {workers.map((w) => {
            const isIdle = w.status === 'IDLE' || !w.windowId
            return (
              <div
                key={w.workerId}
                onClick={() => setSelectedWorkerId(w.workerId)}
                className={`group relative rounded-lg border transition cursor-pointer overflow-hidden flex flex-col ${
                  w.active
                    ? 'border-cyan-500/40 bg-zinc-900/70 hover:border-cyan-400/70'
                    : 'border-zinc-800/80 bg-zinc-900/30 hover:border-zinc-700'
                }`}
              >
                {/* Live Thumbnail Header */}
                <div className="relative aspect-video bg-black border-b border-zinc-800/80 flex items-center justify-center overflow-hidden">
                  {w.screenshotBase64 ? (
                    <img
                      src={`data:image/jpeg;base64,${w.screenshotBase64}`}
                      alt={w.workerId}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="text-[10px] text-zinc-600 font-mono">
                      {w.workerId} · {w.profileDirName}
                    </div>
                  )}

                  {/* Top-left Worker ID + Window # overlay */}
                  <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded bg-black/80 border border-zinc-700 text-[10px] font-mono font-bold text-cyan-300">
                      {w.workerId}
                    </span>
                    {w.windowNumber !== null && (
                      <span className="px-1.5 py-0.5 rounded bg-black/80 border border-zinc-700 text-[10px] font-mono text-zinc-100">
                        #{w.windowNumber} ({w.windowRange})
                      </span>
                    )}
                  </div>

                  {/* Top-right Status Badge */}
                  <div className="absolute top-1.5 right-1.5">
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[9px] font-mono font-semibold uppercase ${statusBadgeStyle(
                        w.status,
                      )}`}
                    >
                      {w.status}
                    </span>
                  </div>

                  {/* Bottom-right expand icon */}
                  <div className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition bg-black/75 p-1 rounded text-zinc-300">
                    <Maximize2 className="w-3 h-3" />
                  </div>
                </div>

                {/* Card Telemetry Body */}
                <div className="p-2.5 flex-1 flex flex-col justify-between gap-1.5 text-[11px]">
                  <div>
                    <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-zinc-400">
                      <span className="text-purple-300 font-medium">
                        {shortModelBadge(w.modelName)}
                      </span>
                      <span>
                        {w.tokens ? `${Math.round(w.tokens / 1000)}K tok` : '— tok'} ·{' '}
                        {formatMmSs(w.elapsedSec)}
                      </span>
                    </div>

                    <div
                      className="mt-1 text-[10px] font-mono text-zinc-300 truncate"
                      title={w.stage}
                    >
                      {w.stage || 'idle'}
                    </div>

                    {!isIdle && (
                      <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-zinc-400">
                        <span>
                          attempt {w.attempt || 1}/{w.maxAttempts || 5}
                        </span>
                        {w.permRetry > 0 && (
                          <span className="text-amber-300">403 retry {w.permRetry}/10</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Per-card controls when a window is assigned */}
                  {w.windowId && (
                    <div
                      className="pt-1.5 border-t border-zinc-800/80 flex items-center justify-end gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          postParallelControl(
                            {
                              action: 'parallel_window_action',
                              windowId: w.windowId,
                              subAction: 'stop',
                            },
                            `stop_${w.windowId}`,
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 text-[10px]"
                        title="Stop this window"
                      >
                        Stop
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          postParallelControl(
                            {
                              action: 'parallel_window_action',
                              windowId: w.windowId,
                              subAction: 'retry',
                            },
                            `retry_${w.windowId}`,
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[10px]"
                        title="Retry this window"
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          postParallelControl(
                            {
                              action: 'parallel_window_action',
                              windowId: w.windowId,
                              subAction: 'skip',
                            },
                            `skip_${w.windowId}`,
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px]"
                        title="Skip this window"
                      >
                        Skip
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* All 18 Planned Windows Status Table / Cards */}
      {windows.length > 0 && (
        <div className="px-4 pb-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2 flex items-center justify-between">
            <span>
              Planned Movie Windows ({windows.length} Windows · Max 5:00 each · 5s seam overlap)
            </span>
            <span className="text-[10px] font-mono text-zinc-500">
              Queue Priority: Largest contiguous runs (71–101, 25–42) pulled first
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1">
            {windows.map((win: ParallelWindowState) => (
              <div
                key={win.id}
                className="rounded-lg border border-zinc-800/90 bg-zinc-900/50 px-3 py-2 flex items-center justify-between gap-2 text-xs"
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
                    {win.workerId && (
                      <span className="px-1.5 py-0.2 rounded bg-cyan-500/15 border border-cyan-500/30 text-[10px] font-mono text-cyan-300">
                        {win.workerId}
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.2 rounded border text-[9px] font-mono font-semibold uppercase ${statusBadgeStyle(
                        win.status,
                      )}`}
                    >
                      {win.status}
                    </span>
                  </div>

                  <div className="mt-0.5 text-[10px] font-mono text-zinc-400 truncate">
                    {win.status === 'DONE' ? (
                      <span className="text-emerald-300 font-medium">{win.summaryText}</span>
                    ) : win.error ? (
                      <span className="text-red-300">{win.error}</span>
                    ) : (
                      <span>
                        {win.stage} · {shortModelBadge(win.modelName)}
                        {win.tokens ? ` · ${Math.round(win.tokens / 1000)}K tok` : ''}
                        {win.attempt > 0 ? ` · try ${win.attempt}/${win.maxAttempts}` : ''}
                        {win.permRetry > 0 ? ` · 403 ${win.permRetry}/10` : ''}
                      </span>
                    )}
                  </div>
                </div>

                {/* Per-window controls */}
                <div className="flex items-center gap-1 shrink-0">
                  {(win.status === 'SETUP' ||
                    win.status === 'RUNNING' ||
                    win.status === 'VALIDATING' ||
                    win.status === 'RETRYING' ||
                    win.status === '403_WAIT' ||
                    win.status === 'QUEUED') && (
                    <button
                      type="button"
                      onClick={() =>
                        postParallelControl(
                          {
                            action: 'parallel_window_action',
                            windowId: win.id,
                            subAction: 'stop',
                          },
                          `win_stop_${win.id}`,
                        )
                      }
                      className="p-1 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30"
                      title="Stop window"
                    >
                      <Square className="w-3 h-3" />
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      postParallelControl(
                        {
                          action: 'parallel_window_action',
                          windowId: win.id,
                          subAction: 'retry',
                        },
                        `win_retry_${win.id}`,
                      )
                    }
                    className="p-1 rounded bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30"
                    title="Retry window"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>

                  {win.status !== 'DONE' && win.status !== 'SKIPPED' && (
                    <button
                      type="button"
                      onClick={() =>
                        postParallelControl(
                          {
                            action: 'parallel_window_action',
                            windowId: win.id,
                            subAction: 'skip',
                          },
                          `win_skip_${win.id}`,
                        )
                      }
                      className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700"
                      title="Skip window"
                    >
                      <SkipForward className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Final Merged Result Viewer (TXT + JSON) */}
      {mergedReport && mergedReport.totalShortSegments > 0 && (
        <div className="border-t border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-200">
                Merged Final Result (HISSA 1 + HISSA 2)
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                {mergedReport.foundCount} FOUND
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                {mergedReport.notFoundCount} NOT FOUND
              </span>
              {mergedReport.conflictCount > 0 && (
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {mergedReport.conflictCount} CONFLICT
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setReportTab('txt')}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border ${
                  reportTab === 'txt'
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                }`}
              >
                <FileText className="w-3 h-3" />
                TXT
              </button>
              <button
                type="button"
                onClick={() => setReportTab('json')}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border ${
                  reportTab === 'json'
                    ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-800'
                }`}
              >
                <FileCode className="w-3 h-3" />
                JSON
              </button>
              <button
                type="button"
                onClick={handleCopyReport}
                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              >
                <Copy className="w-3 h-3" />
                {copiedReport ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => handleDownloadReport('txt')}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              >
                <Download className="w-3 h-3" />
                .txt
              </button>
              <button
                type="button"
                onClick={() => handleDownloadReport('json')}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
              >
                <Download className="w-3 h-3" />
                .json
              </button>
            </div>
          </div>

          <pre className="max-h-64 overflow-y-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-[11px] font-mono text-zinc-200 whitespace-pre-wrap">
            {reportTab === 'txt'
              ? mergedReport.formattedTxt
              : JSON.stringify(mergedReport, null, 2)}
          </pre>
        </div>
      )}

      {/* Modal for Worker Large Screenshot + [Wxx] Step Log (200 lines) */}
      {selectedWorker && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setSelectedWorkerId(null)}
        >
          <div
            className="w-full max-w-5xl rounded-xl border border-zinc-700 bg-zinc-950 overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-500/40 text-xs font-mono font-bold text-cyan-300">
                  {selectedWorker.workerId}
                </span>
                <span className="text-xs font-mono text-zinc-300">
                  Profile: {selectedWorker.profileDirName}
                </span>
                {selectedWorker.windowNumber !== null && (
                  <span className="text-xs font-mono text-zinc-100">
                    · Window #{selectedWorker.windowNumber} ({selectedWorker.windowRange})
                  </span>
                )}
                <span
                  className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold uppercase ${statusBadgeStyle(
                    selectedWorker.status,
                  )}`}
                >
                  {selectedWorker.status}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedWorkerId(null)}
                className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 overflow-hidden">
              <div className="lg:col-span-7 bg-black flex items-center justify-center border-b lg:border-b-0 lg:border-r border-zinc-800 p-2">
                {selectedWorker.screenshotBase64 ? (
                  <img
                    src={`data:image/jpeg;base64,${selectedWorker.screenshotBase64}`}
                    alt={selectedWorker.workerId}
                    className="max-h-[65vh] w-auto object-contain rounded"
                  />
                ) : (
                  <div className="text-xs font-mono text-zinc-500 py-16">
                    No live screenshot captured yet for {selectedWorker.workerId}
                  </div>
                )}
              </div>

              <div className="lg:col-span-5 flex flex-col max-h-[65vh]">
                <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900/60 flex items-center justify-between text-[11px] font-mono text-zinc-400">
                  <span>
                    [{selectedWorker.workerId}] Step Log ({selectedWorker.logs.length}/200 lines)
                  </span>
                  <span>
                    {shortModelBadge(selectedWorker.modelName)} ·{' '}
                    {selectedWorker.tokens
                      ? `${selectedWorker.tokens.toLocaleString()} tok`
                      : '— tok'}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-[11px]">
                  {selectedWorker.logs.length === 0 ? (
                    <div className="text-zinc-600">No logs recorded yet.</div>
                  ) : (
                    selectedWorker.logs
                      .slice()
                      .reverse()
                      .map((log, i) => (
                        <div key={`${log.t}-${i}`} className="leading-snug flex items-start gap-1.5">
                          <span className="text-zinc-600 shrink-0">
                            {new Date(log.t).toLocaleTimeString([], {
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                          <span
                            className={
                              log.level === 'error'
                                ? 'text-red-400'
                                : log.level === 'warn'
                                  ? 'text-amber-300'
                                  : log.level === 'success'
                                    ? 'text-emerald-400'
                                    : 'text-zinc-300'
                            }
                          >
                            <strong className="font-semibold">{log.step}</strong>
                            {log.detail ? ` — ${log.detail}` : ''}
                          </span>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
