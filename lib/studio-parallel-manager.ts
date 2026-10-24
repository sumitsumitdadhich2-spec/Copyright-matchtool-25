import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { DATA_DIR, MEDIA_DIR } from './paths'
import {
  StudioBrowserController,
  type StudioStepLog,
} from './studio-automation'
import {
  buildParallelWindowsFromMinuteInput,
  mergeParallelWindowResults,
  splitParallelWindowInHalf,
  type ParallelMergedReport,
  type ParallelWindowSpec,
} from './studio-window-planner'
import {
  DEFAULT_STUDIO_CONCURRENCY,
  DEFAULT_STUDIO_MINUTE_INPUT,
  loadStudioUserConfig,
} from './studio-settings'
import type { ChunkMatch } from './types'

export type ParallelWindowStatus =
  | 'QUEUED'
  | 'SETUP'
  | 'RUNNING'
  | 'VALIDATING'
  | 'RETRYING'
  | '403_WAIT'
  | 'DONE'
  | 'FAILED'
  | 'NEEDS_ATTENTION'
  | 'STOPPED'
  | 'SKIPPED'

export interface ParallelWindowState extends ParallelWindowSpec {
  status: ParallelWindowStatus
  workerId: string | null
  modelName: string
  stage: string
  tokens: number | null
  attempt: number
  maxAttempts: number
  permRetry: number
  startedAt: number | null
  finishedAt: number | null
  elapsedSec: number
  matchCount: number
  summaryText: string
  rawResponseText?: string
  matches?: ChunkMatch[]
  error?: string | null
}

export interface ParallelWorkerCardSnapshot {
  workerId: string // "W01" .. "W10"
  workerIndex: number // 1 .. 10
  profileDirName: string // "studio-chrome-profile-w01"
  active: boolean
  status: ParallelWindowStatus | 'IDLE'
  windowId: string | null
  windowNumber: number | null
  windowRange: string | null
  runLabel: string | null
  modelName: string
  stage: string
  tokens: number | null
  elapsedSec: number
  attempt: number
  maxAttempts: number
  permRetry: number
  summaryText: string | null
  screenshotBase64: string | null
  screenshotAt: number | null
  logs: StudioStepLog[]
}

export interface ParallelScanLiveSnapshot {
  active: boolean
  paused: boolean
  scanId: string | null
  username: string | null
  minuteInput: string
  concurrency: number
  measuredTokenRate: number | null
  startedAt: number | null
  elapsedSec: number
  activeWorkersCount: number
  doneCount: number
  queuedCount: number
  failedCount: number
  needsAttentionCount: number
  totalWindows: number
  ramUsedPercent: number
  freeDiskGb: number
  resourceWarning: string | null
  workers: ParallelWorkerCardSnapshot[]
  windows: ParallelWindowState[]
  mergedReport: ParallelMergedReport | null
}

interface PersistedParallelState {
  version: 1
  scanId: string | null
  username: string
  minuteInput: string
  concurrency: number
  shortLocalPath: string | null
  shortYoutubeUrl: string | null
  shortDriveFileName: string | null
  shortDurationSec: number
  movieLocalPath: string | null
  movieDriveFileName: string | null
  movieDurationSec: number
  startedAt: number
  updatedAt: number
  windows: ParallelWindowState[]
}

const PARALLEL_STATE_FILE = path.join(DATA_DIR, 'studio-parallel-state.json')
const BASE_PROFILE_NAME = 'studio-chrome-profile'

function readSystemRamUsedPercent(): number {
  try {
    if (fs.existsSync('/proc/meminfo')) {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8')
      const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/i)
      const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/i)
      if (totalMatch && availMatch) {
        const total = Number(totalMatch[1])
        const avail = Number(availMatch[1])
        if (total > 0) {
          return Math.round(((total - avail) / total) * 100)
        }
      }
    }
  } catch {
    /* fallback to os module */
  }
  const total = os.totalmem()
  const free = os.freemem()
  if (total <= 0) return 0
  return Math.round(((total - free) / total) * 100)
}

function readFreeDiskGb(): number {
  try {
    const stat = fs.statfsSync(DATA_DIR)
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    return Math.round((freeBytes / 1024 ** 3) * 10) / 10
  } catch {
    return 50
  }
}

/**
 * Clone base profile `data/studio-chrome-profile` into `data/studio-chrome-profile-wXX`
 * excluding SingletonLock/SingletonCookie/SingletonSocket and heavy browser cache folders.
 */
function syncWorkerProfileFromBase(workerIndex: number): string {
  const workerSuffix = String(workerIndex).padStart(2, '0')
  const profileDirName = `${BASE_PROFILE_NAME}-w${workerSuffix}`
  const baseDir = path.join(DATA_DIR, BASE_PROFILE_NAME)
  const targetDir = path.join(DATA_DIR, profileDirName)

  fs.mkdirSync(DATA_DIR, { recursive: true })

  const baseCookiesPath = path.join(baseDir, 'Default', 'Cookies')
  const targetCookiesPath = path.join(targetDir, 'Default', 'Cookies')

  const shouldCopyFromBase =
    fs.existsSync(baseDir) &&
    (!fs.existsSync(targetDir) ||
      (fs.existsSync(baseCookiesPath) &&
        (!fs.existsSync(targetCookiesPath) ||
          fs.statSync(baseCookiesPath).mtimeMs > fs.statSync(targetCookiesPath).mtimeMs)))

  if (shouldCopyFromBase) {
    try {
      fs.mkdirSync(targetDir, { recursive: true })
      const entries = fs.readdirSync(baseDir)
      const skipTopLevel = new Set([
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'RunningChromeVersion',
        'BrowserMetrics',
        'Crashpad',
        'GrShaderCache',
        'ShaderCache',
        'GraphiteDawnCache',
      ])
      for (const entry of entries) {
        if (skipTopLevel.has(entry) || entry.startsWith('Singleton')) continue
        const srcPath = path.join(baseDir, entry)
        const dstPath = path.join(targetDir, entry)
        if (entry === 'Default') {
          fs.mkdirSync(dstPath, { recursive: true })
          const defEntries = fs.readdirSync(srcPath)
          const skipDef = new Set([
            'Cache',
            'Code Cache',
            'GPUCache',
            'DawnCache',
            'Service Worker',
            'LOCK',
          ])
          for (const dEntry of defEntries) {
            if (skipDef.has(dEntry)) continue
            try {
              execFileSync('cp', ['-a', path.join(srcPath, dEntry), path.join(dstPath, dEntry)], {
                stdio: 'ignore',
              })
            } catch {
              /* ignore locked file during copy */
            }
          }
        } else {
          try {
            execFileSync('cp', ['-a', srcPath, dstPath], { stdio: 'ignore' })
          } catch {
            /* ignore locked file */
          }
        }
      }
    } catch {
      /* fallback to empty profile directory; cookies will be injected via Playwright */
      fs.mkdirSync(targetDir, { recursive: true })
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(targetDir, lockName), { force: true })
    } catch {
      /* ignore */
    }
  }

  return profileDirName
}

function mapStepToWindowStatus(step: string): ParallelWindowStatus {
  const s = (step || '').toLowerCase()
  if (s.includes('needs attention')) return 'NEEDS_ATTENTION'
  if (s.includes('permission denied') || s.includes('403 ->')) return '403_WAIT'
  if (s.includes('retry [')) return 'RETRYING'
  if (s.includes('validate') || s.includes('copy')) return 'VALIDATING'
  if (s.includes('running ')) return 'RUNNING'
  return 'SETUP'
}

export class StudioParallelManager {
  private workers = new Map<number, StudioBrowserController>()
  private workerActiveWindowId = new Map<number, string | null>()
  private windows: ParallelWindowState[] = []
  private active = false
  private paused = false
  private stoppingAll = false
  private stoppedWindowIds = new Set<string>()
  private scanId: string | null = null
  private username: string | null = null
  private minuteInput: string = DEFAULT_STUDIO_MINUTE_INPUT
  private concurrency: number = DEFAULT_STUDIO_CONCURRENCY
  private measuredTokenRate: number | null = null
  private startedAt: number | null = null
  private shortLocalPath: string | null = null
  private shortYoutubeUrl: string | null = null
  private shortDriveFileName: string | null = null
  private shortDurationSec: number = 150
  private movieLocalPath: string | null = null
  private movieDriveFileName: string | null = null
  private movieDurationSec: number = 6600
  private resourceWarning: string | null = null
  private onMatchCallback?: (windowState: ParallelWindowState, matches: ChunkMatch[]) => Promise<void>
  private onLogCallback?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void

  constructor() {
    this.tryRestorePersistedState()
  }

  private tryRestorePersistedState() {
    try {
      if (!fs.existsSync(PARALLEL_STATE_FILE)) return
      const raw = JSON.parse(fs.readFileSync(PARALLEL_STATE_FILE, 'utf8')) as PersistedParallelState
      if (!raw || !Array.isArray(raw.windows) || raw.windows.length === 0) return
      this.scanId = raw.scanId
      this.username = raw.username
      this.minuteInput = raw.minuteInput || DEFAULT_STUDIO_MINUTE_INPUT
      this.concurrency = raw.concurrency || DEFAULT_STUDIO_CONCURRENCY
      this.shortLocalPath = raw.shortLocalPath
      this.shortYoutubeUrl = raw.shortYoutubeUrl
      this.shortDriveFileName = raw.shortDriveFileName
      this.shortDurationSec = raw.shortDurationSec || 150
      this.movieLocalPath = raw.movieLocalPath
      this.movieDriveFileName = raw.movieDriveFileName
      this.movieDurationSec = raw.movieDurationSec || 6600
      this.startedAt = raw.startedAt || null
      // Any window that was in-flight when container restarted goes back to QUEUED; DONE stays DONE
      this.windows = raw.windows.map((w) => {
        if (
          w.status === 'SETUP' ||
          w.status === 'RUNNING' ||
          w.status === 'VALIDATING' ||
          w.status === 'RETRYING' ||
          w.status === '403_WAIT'
        ) {
          return {
            ...w,
            status: 'QUEUED',
            workerId: null,
            stage: 'queued (resumed)',
          }
        }
        return {
          ...w,
          workerId: null,
        }
      })
    } catch {
      /* ignore corrupt state file */
    }
  }

  private persistStateToDisk() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const payload: PersistedParallelState = {
        version: 1,
        scanId: this.scanId,
        username: this.username || 'admin',
        minuteInput: this.minuteInput,
        concurrency: this.concurrency,
        shortLocalPath: this.shortLocalPath,
        shortYoutubeUrl: this.shortYoutubeUrl,
        shortDriveFileName: this.shortDriveFileName,
        shortDurationSec: this.shortDurationSec,
        movieLocalPath: this.movieLocalPath,
        movieDriveFileName: this.movieDriveFileName,
        movieDurationSec: this.movieDurationSec,
        startedAt: this.startedAt || Date.now(),
        updatedAt: Date.now(),
        windows: this.windows,
      }
      fs.writeFileSync(PARALLEL_STATE_FILE, JSON.stringify(payload, null, 2), 'utf8')

      if (this.scanId) {
        const scanParallelDir = path.join(DATA_DIR, 'scans', this.scanId)
        fs.mkdirSync(scanParallelDir, { recursive: true })
        fs.writeFileSync(
          path.join(scanParallelDir, 'parallel-windows.json'),
          JSON.stringify(payload, null, 2),
          'utf8',
        )
        const report = this.getMergedReport()
        if (report) {
          fs.writeFileSync(
            path.join(scanParallelDir, 'parallel-merged-report.json'),
            JSON.stringify(report, null, 2),
            'utf8',
          )
          fs.writeFileSync(
            path.join(scanParallelDir, 'parallel-merged-report.txt'),
            report.formattedTxt,
            'utf8',
          )
        }
      }
    } catch {
      /* ignore disk write error */
    }
  }

  private getOrCreateWorker(workerIndex: number): StudioBrowserController {
    let ctrl = this.workers.get(workerIndex)
    if (!ctrl) {
      const workerTag = `[W${String(workerIndex).padStart(2, '0')}]`
      const profileDirName = syncWorkerProfileFromBase(workerIndex)
      ctrl = new StudioBrowserController({
        profileDirName,
        workerTag,
      })
      this.workers.set(workerIndex, ctrl)
    }
    return ctrl
  }

  public isRunning(): boolean {
    return this.active
  }

  public getMergedReport(): ParallelMergedReport | null {
    if (this.windows.length === 0) return null
    return mergeParallelWindowResults({
      windows: this.windows,
    })
  }

  /**
   * Build / preview the 18 windows from minuteInput without starting Chrome workers yet.
   */
  public previewPlan(minuteInput?: string, movieDurationSec?: number): ParallelWindowState[] {
    const input = (minuteInput || this.minuteInput || DEFAULT_STUDIO_MINUTE_INPUT).trim()
    const { windows } = buildParallelWindowsFromMinuteInput(input, movieDurationSec)
    return windows.map((w) => ({
      ...w,
      status: 'QUEUED',
      workerId: null,
      modelName: 'Gemini 3.8 Flash',
      stage: 'queued',
      tokens: null,
      attempt: 0,
      maxAttempts: 5,
      permRetry: 0,
      startedAt: null,
      finishedAt: null,
      elapsedSec: 0,
      matchCount: 0,
      summaryText: 'Queued',
      error: null,
    }))
  }

  /**
   * Auto-detect latest scan media files from `data/media/<scanId>` if not explicitly provided.
   */
  private resolveMediaPaths(scanId?: string | null): {
    resolvedScanId: string | null
    shortLocalPath: string | null
    movieLocalPath: string | null
  } {
    if (scanId) {
      const dir = path.join(MEDIA_DIR, scanId)
      const shortP = path.join(dir, 'short.mp4')
      const movie360 = path.join(dir, 'movie_360p.mp4')
      const movieRaw = path.join(dir, 'movie.mp4')
      return {
        resolvedScanId: scanId,
        shortLocalPath: fs.existsSync(shortP) ? shortP : null,
        movieLocalPath: fs.existsSync(movie360)
          ? movie360
          : fs.existsSync(movieRaw)
            ? movieRaw
            : null,
      }
    }

    // Find most recently modified scan directory in MEDIA_DIR that has short.mp4 and movie.mp4
    try {
      if (fs.existsSync(MEDIA_DIR)) {
        const dirs = fs
          .readdirSync(MEDIA_DIR)
          .map((d) => ({ id: d, full: path.join(MEDIA_DIR, d) }))
          .filter((d) => {
            try {
              return (
                fs.statSync(d.full).isDirectory() &&
                fs.existsSync(path.join(d.full, 'short.mp4')) &&
                (fs.existsSync(path.join(d.full, 'movie_360p.mp4')) ||
                  fs.existsSync(path.join(d.full, 'movie.mp4')))
              )
            } catch {
              return false
            }
          })
          .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs)

        if (dirs.length > 0) {
          const best = dirs[0]
          const movie360 = path.join(best.full, 'movie_360p.mp4')
          const movieRaw = path.join(best.full, 'movie.mp4')
          return {
            resolvedScanId: best.id,
            shortLocalPath: path.join(best.full, 'short.mp4'),
            movieLocalPath: fs.existsSync(movie360) ? movie360 : movieRaw,
          }
        }
      }
    } catch {
      /* ignore */
    }
    return { resolvedScanId: null, shortLocalPath: null, movieLocalPath: null }
  }

  /**
   * Start or resume a Parallel Window Scan across N isolated Chrome workers.
   */
  public async startParallelScan(params: {
    username: string
    scanId?: string | null
    minuteInput?: string
    concurrency?: number
    shortLocalPath?: string | null
    shortYoutubeUrl?: string | null
    shortDriveFileName?: string | null
    shortDurationSec?: number
    movieLocalPath?: string | null
    movieDriveFileName?: string | null
    movieDurationSec?: number
    resumeExisting?: boolean
    onWindowMatches?: (windowState: ParallelWindowState, matches: ChunkMatch[]) => Promise<void>
    onLog?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void
  }): Promise<{ totalWindows: number; concurrency: number; scanId: string | null }> {
    if (this.active) {
      throw new Error('Parallel Window Scan is already running')
    }

    const cfg = await loadStudioUserConfig(params.username)
    this.username = params.username
    this.minuteInput = (params.minuteInput || cfg.studioMinuteInput || DEFAULT_STUDIO_MINUTE_INPUT).trim()
    this.concurrency = Math.max(
      1,
      Math.min(20, Number(params.concurrency ?? cfg.studioConcurrency ?? DEFAULT_STUDIO_CONCURRENCY)),
    )
    this.measuredTokenRate = cfg.studioMeasuredTokenRate ?? null
    this.onMatchCallback = params.onWindowMatches
    this.onLogCallback = params.onLog

    const mediaResolved = this.resolveMediaPaths(params.scanId ?? this.scanId)
    this.scanId = params.scanId ?? mediaResolved.resolvedScanId
    this.shortLocalPath = params.shortLocalPath ?? mediaResolved.shortLocalPath ?? this.shortLocalPath
    this.shortYoutubeUrl = params.shortYoutubeUrl ?? this.shortYoutubeUrl
    this.shortDriveFileName = params.shortDriveFileName ?? this.shortDriveFileName
    this.shortDurationSec = params.shortDurationSec || this.shortDurationSec || 150
    this.movieLocalPath = params.movieLocalPath ?? mediaResolved.movieLocalPath ?? this.movieLocalPath
    this.movieDriveFileName = params.movieDriveFileName ?? this.movieDriveFileName
    this.movieDurationSec = params.movieDurationSec || this.movieDurationSec || 6600

    const canResume =
      params.resumeExisting &&
      this.windows.length > 0 &&
      this.windows.some((w) => w.status === 'DONE' || w.status === 'QUEUED')

    if (!canResume) {
      const { windows } = buildParallelWindowsFromMinuteInput(
        this.minuteInput,
        this.movieDurationSec,
      )
      this.windows = windows.map((w) => ({
        ...w,
        status: 'QUEUED',
        workerId: null,
        modelName: cfg.studioModelName || 'Gemini 3.8 Flash',
        stage: 'queued',
        tokens: null,
        attempt: 0,
        maxAttempts: 5,
        permRetry: 0,
        startedAt: null,
        finishedAt: null,
        elapsedSec: 0,
        matchCount: 0,
        summaryText: 'Queued',
        error: null,
      }))
      this.startedAt = Date.now()
    } else {
      // Reset any non-DONE windows that should be run
      for (const w of this.windows) {
        if (w.status !== 'DONE' && w.status !== 'SKIPPED') {
          w.status = 'QUEUED'
          w.workerId = null
          w.stage = 'queued'
          w.error = null
        }
      }
      if (!this.startedAt) this.startedAt = Date.now()
    }

    this.active = true
    this.paused = false
    this.stoppingAll = false
    this.stoppedWindowIds.clear()
    this.persistStateToDisk()

    // Pre-create worker controllers so UI immediately displays all N worker cards
    for (let i = 1; i <= this.concurrency; i++) {
      this.getOrCreateWorker(i)
    }

    // Fire-and-forget the worker pool loop (or callers can await waitForCompletion())
    this.runWorkerPoolLoop().catch((err) => {
      this.onLogCallback?.('error', `Parallel worker pool error: ${(err as Error).message}`)
    })

    return {
      totalWindows: this.windows.length,
      concurrency: this.concurrency,
      scanId: this.scanId,
    }
  }

  public async waitForCompletion(): Promise<ParallelMergedReport | null> {
    while (this.active) {
      await new Promise((r) => setTimeout(r, 1000))
    }
    return this.getMergedReport()
  }

  private pullNextQueuedWindow(): ParallelWindowState | null {
    if (this.stoppingAll) return null
    const candidates = this.windows
      .filter((w) => w.status === 'QUEUED' && !this.stoppedWindowIds.has(w.id))
      .sort((a, b) => a.priorityRank - b.priorityRank || a.windowNumber - b.windowNumber)
    return candidates[0] || null
  }

  private async runWorkerPoolLoop(): Promise<void> {
    const workerCount = this.concurrency
    const workerPromises: Promise<void>[] = []

    for (let wIdx = 1; wIdx <= workerCount; wIdx++) {
      workerPromises.push(this.runSingleWorkerLoop(wIdx))
    }

    await Promise.allSettled(workerPromises)
    this.active = false
    this.persistStateToDisk()
  }

  private async runSingleWorkerLoop(workerIndex: number): Promise<void> {
    const workerId = `W${String(workerIndex).padStart(2, '0')}`
    const ctrl = this.getOrCreateWorker(workerIndex)
    ctrl.clearStop()

    // 10-15s stagger between worker starts so 10 Chrome instances & video uploads don't spike simultaneously
    if (workerIndex > 1) {
      const staggerMs = (workerIndex - 1) * 12_000
      ctrl.logStep('stagger wait', `Waiting ${Math.round(staggerMs / 1000)}s stagger before launching ${workerId}`)
      const waitEnd = Date.now() + staggerMs
      while (Date.now() < waitEnd) {
        if (this.stoppingAll) return
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    while (!this.stoppingAll) {
      while (this.paused && !this.stoppingAll) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (this.stoppingAll) break

      const nextWin = this.pullNextQueuedWindow()
      if (!nextWin) {
        // Check if any other worker is still running (in case a window splits into 2 halves)
        const anyInFlight = this.windows.some(
          (w) =>
            w.status === 'SETUP' ||
            w.status === 'RUNNING' ||
            w.status === 'VALIDATING' ||
            w.status === 'RETRYING' ||
            w.status === '403_WAIT',
        )
        const anyQueued = this.windows.some((w) => w.status === 'QUEUED')
        if (!anyQueued && !anyInFlight) {
          break
        }
        if (!anyQueued && anyInFlight) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
      }
      if (!nextWin) break

      // Resource check before starting window (RAM & Disk)
      const freeDiskGb = readFreeDiskGb()
      if (freeDiskGb < 5) {
        this.resourceWarning = `WARN: Low disk space (${freeDiskGb} GB free < 5 GB)`
        ctrl.logStep('WARN [low-disk]', this.resourceWarning, 'warn')
        this.onLogCallback?.('warn', `[${workerId}] ${this.resourceWarning}`)
      }
      let ramPct = readSystemRamUsedPercent()
      while (ramPct > 85 && !this.stoppingAll) {
        this.resourceWarning = `WARN: High RAM usage (${ramPct}% > 85%) — throttling new worker start`
        ctrl.logStep('WARN [ram-throttle]', this.resourceWarning, 'warn')
        await new Promise((r) => setTimeout(r, 3000))
        ramPct = readSystemRamUsedPercent()
        // If this is the only active worker, don't deadlock
        const activeCount = Array.from(this.workerActiveWindowId.values()).filter(Boolean).length
        if (activeCount === 0) break
      }

      await this.executeWindowOnWorker(workerIndex, ctrl, nextWin)

      // If worker hit NEEDS_ATTENTION (login expired / API key prompt), stop pulling new windows on this worker
      if (nextWin.status === 'NEEDS_ATTENTION') {
        ctrl.logStep('worker halted', `Halted ${workerId} due to NEEDS ATTENTION on ${nextWin.id}`, 'error')
        break
      }
    }

    this.workerActiveWindowId.set(workerIndex, null)
  }

  private async executeWindowOnWorker(
    workerIndex: number,
    ctrl: StudioBrowserController,
    win: ParallelWindowState,
  ): Promise<void> {
    const workerId = `W${String(workerIndex).padStart(2, '0')}`
    const jobScanScope = `parallel-${this.scanId || 'scan'}-${win.id}`
    ctrl.clearStop({ scanId: jobScanScope, username: this.username })

    this.workerActiveWindowId.set(workerIndex, win.id)
    win.status = 'SETUP'
    win.workerId = workerId
    win.startedAt = Date.now()
    win.finishedAt = null
    win.error = null
    win.summaryText = `Running on ${workerId}...`
    this.persistStateToDisk()

    const cfg = await loadStudioUserConfig(this.username || 'admin')
    const jobLabel = `Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted})`

    try {
      const result = await ctrl.runWindowJob({
        username: this.username || 'admin',
        scanId: jobScanScope,
        jobLabel,
        modelName: cfg.studioModelName || 'Gemini 3.8 Flash',
        maxOutputTokens: cfg.studioMaxOutputTokens || 65536,
        maxInputTokens: cfg.studioMaxInputTokens,
        pageRecycleInterval: cfg.studioPageRecycleInterval || 5,
        shortYoutubeUrl: this.shortYoutubeUrl,
        shortDriveFileName: this.shortDriveFileName,
        shortLocalPath: this.shortLocalPath,
        shortStartSec: 0,
        shortEndSec: this.shortDurationSec,
        movieDriveFileName: this.movieDriveFileName,
        movieLocalPath: this.movieLocalPath,
        movieStartSec: win.startSec,
        movieEndSec: win.endSec,
        parallelMode: true,
        maxAttempts: 5,
        measuredTokenRate: this.measuredTokenRate ?? cfg.studioMeasuredTokenRate ?? null,
        onLog: (level, msg) => {
          this.onLogCallback?.(level, `[${workerId}] ${msg}`)
        },
      })

      if (result.status === 'shrink_needed') {
        // Split window into 2 equal halves and enqueue both!
        const nextNum = this.windows.length + 1
        const [half1, half2] = splitParallelWindowInHalf(win, nextNum)
        const makeState = (spec: ParallelWindowSpec): ParallelWindowState => ({
          ...spec,
          status: 'QUEUED',
          workerId: null,
          modelName: cfg.studioModelName || 'Gemini 3.8 Flash',
          stage: 'queued (split)',
          tokens: null,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          startedAt: null,
          finishedAt: null,
          elapsedSec: 0,
          matchCount: 0,
          summaryText: 'Queued (split from context-limit)',
          error: null,
        })

        const idx = this.windows.findIndex((w) => w.id === win.id)
        if (idx !== -1) {
          this.windows.splice(idx, 1, makeState(half1), makeState(half2))
        } else {
          this.windows.push(makeState(half1), makeState(half2))
        }
        this.persistStateToDisk()
        return
      }

      const meta = ctrl.getActiveRunMeta()
      win.status = 'DONE'
      win.modelName = meta.modelName
      win.tokens = result.tokenCount
      win.attempt = meta.attempt
      win.permRetry = meta.permRetry
      win.finishedAt = Date.now()
      win.elapsedSec = win.startedAt ? Math.round((win.finishedAt - win.startedAt) / 1000) : 0
      win.rawResponseText = result.rawText
      win.matches = result.matches
      win.matchCount = result.matches.length
      win.stage = 'done'
      win.summaryText =
        result.matches.length > 0 ? `${result.matches.length} matches` : '0 matches'
      this.persistStateToDisk()

      if (this.onMatchCallback) {
        await this.onMatchCallback(win, result.matches).catch(() => {})
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const meta = ctrl.getActiveRunMeta()
      win.modelName = meta.modelName
      win.tokens = meta.tokenCount
      win.attempt = meta.attempt
      win.permRetry = meta.permRetry
      win.finishedAt = Date.now()
      win.elapsedSec = win.startedAt ? Math.round((win.finishedAt - win.startedAt) / 1000) : 0

      if (msg === 'STOPPED BY USER' || this.stoppedWindowIds.has(win.id) || this.stoppingAll) {
        if ((win.status as string) !== 'SKIPPED') {
          win.status = 'STOPPED'
          win.stage = 'stopped'
          win.summaryText = 'STOPPED BY USER'
          win.error = 'STOPPED BY USER'
        }
      } else if (msg.startsWith('NEEDS_ATTENTION:')) {
        win.status = 'NEEDS_ATTENTION'
        win.stage = 'needs attention'
        win.summaryText = msg.replace(/^NEEDS_ATTENTION:\s*/, '')
        win.error = msg
      } else {
        win.status = 'FAILED'
        win.stage = 'failed'
        win.summaryText = msg.slice(0, 120)
        win.error = msg
      }
      this.persistStateToDisk()
    } finally {
      this.workerActiveWindowId.set(workerIndex, null)
    }
  }

  public pauseAll() {
    this.paused = true
    for (const ctrl of this.workers.values()) {
      ctrl.setPaused(true)
    }
  }

  public resumeAll() {
    this.paused = false
    for (const ctrl of this.workers.values()) {
      ctrl.setPaused(false)
    }
  }

  public stopAll() {
    this.stoppingAll = true
    this.paused = false
    for (const ctrl of this.workers.values()) {
      ctrl.requestStop()
    }
    for (const w of this.windows) {
      if (w.status === 'QUEUED') {
        w.status = 'STOPPED'
        w.stage = 'stopped'
        w.summaryText = 'STOPPED BY USER'
      }
    }
    this.active = false
    this.persistStateToDisk()
  }

  public stopWindow(windowId: string) {
    this.stoppedWindowIds.add(windowId)
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return

    if (win.status === 'QUEUED') {
      win.status = 'STOPPED'
      win.stage = 'stopped'
      win.summaryText = 'STOPPED BY USER'
      this.persistStateToDisk()
      return
    }

    const jobScanScope = `parallel-${this.scanId || 'scan'}-${win.id}`
    for (const [wIdx, activeWinId] of this.workerActiveWindowId.entries()) {
      if (activeWinId === windowId) {
        const ctrl = this.workers.get(wIdx)
        ctrl?.requestStop({ scanId: jobScanScope })
      }
    }
  }

  public skipWindow(windowId: string) {
    this.stoppedWindowIds.add(windowId)
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return
    const prevStatus = win.status
    win.status = 'SKIPPED'
    win.stage = 'skipped'
    win.summaryText = 'Skipped by user'
    this.persistStateToDisk()

    if (
      prevStatus === 'SETUP' ||
      prevStatus === 'RUNNING' ||
      prevStatus === 'VALIDATING' ||
      prevStatus === 'RETRYING' ||
      prevStatus === '403_WAIT'
    ) {
      const jobScanScope = `parallel-${this.scanId || 'scan'}-${win.id}`
      for (const [wIdx, activeWinId] of this.workerActiveWindowId.entries()) {
        if (activeWinId === windowId) {
          this.workers.get(wIdx)?.requestStop({ scanId: jobScanScope })
        }
      }
    }
  }

  public async retryWindow(windowId: string, username?: string) {
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return
    this.stoppedWindowIds.delete(windowId)
    win.status = 'QUEUED'
    win.workerId = null
    win.stage = 'queued (retry)'
    win.error = null
    win.summaryText = 'Queued for retry'
    this.persistStateToDisk()

    if (!this.active) {
      await this.startParallelScan({
        username: username || this.username || 'admin',
        scanId: this.scanId,
        minuteInput: this.minuteInput,
        concurrency: this.concurrency,
        resumeExisting: true,
      })
    }
  }

  public async retryFailedWindows(username?: string) {
    let count = 0
    for (const w of this.windows) {
      if (
        w.status === 'FAILED' ||
        w.status === 'STOPPED' ||
        w.status === 'NEEDS_ATTENTION'
      ) {
        this.stoppedWindowIds.delete(w.id)
        w.status = 'QUEUED'
        w.workerId = null
        w.stage = 'queued (retry)'
        w.error = null
        w.summaryText = 'Queued for retry'
        count++
      }
    }
    this.persistStateToDisk()

    if (count > 0 && !this.active) {
      await this.startParallelScan({
        username: username || this.username || 'admin',
        scanId: this.scanId,
        minuteInput: this.minuteInput,
        concurrency: this.concurrency,
        resumeExisting: true,
      })
    }
    return count
  }

  public async getLiveSnapshot(captureThumbnails = true): Promise<ParallelScanLiveSnapshot> {
    // Sync live in-flight window telemetry from active workers
    for (const [wIdx, activeWinId] of this.workerActiveWindowId.entries()) {
      if (!activeWinId) continue
      const ctrl = this.workers.get(wIdx)
      const win = this.windows.find((w) => w.id === activeWinId)
      if (ctrl && win) {
        const meta = ctrl.getActiveRunMeta()
        win.modelName = meta.modelName
        win.tokens = meta.tokenCount
        win.attempt = meta.attempt
        win.maxAttempts = meta.maxAttempts
        win.permRetry = meta.permRetry
        win.stage = meta.currentStep
        win.status = mapStepToWindowStatus(meta.currentStep)
        win.elapsedSec = win.startedAt ? Math.round((Date.now() - win.startedAt) / 1000) : 0
      }
    }

    const workerCards: ParallelWorkerCardSnapshot[] = []
    const totalCards = Math.max(this.concurrency, this.workers.size || DEFAULT_STUDIO_CONCURRENCY)

    for (let i = 1; i <= totalCards; i++) {
      const workerId = `W${String(i).padStart(2, '0')}`
      const profileDirName = `${BASE_PROFILE_NAME}-w${String(i).padStart(2, '0')}`
      const ctrl = this.workers.get(i)
      const activeWinId = this.workerActiveWindowId.get(i) || null
      const activeWin = activeWinId ? this.windows.find((w) => w.id === activeWinId) || null : null

      if (ctrl) {
        const snap = await ctrl.getSnapshot(captureThumbnails && Boolean(activeWinId), {
          quality: 38,
          minIntervalMs: 3000,
          maxLogs: 200,
        })
        const meta = ctrl.getActiveRunMeta()
        workerCards.push({
          workerId,
          workerIndex: i,
          profileDirName: ctrl.profileDirName,
          active: Boolean(activeWinId),
          status: activeWin ? activeWin.status : 'IDLE',
          windowId: activeWin?.id ?? null,
          windowNumber: activeWin?.windowNumber ?? null,
          windowRange: activeWin ? `${activeWin.startFormatted}–${activeWin.endFormatted}` : null,
          runLabel: activeWin?.runLabel ?? null,
          modelName: activeWin?.modelName || meta.modelName || 'Gemini 3.8 Flash',
          stage: activeWin ? meta.currentStep : snap.currentStep || 'idle',
          tokens: activeWin ? meta.tokenCount : snap.tokenCount,
          elapsedSec: activeWin?.elapsedSec ?? snap.elapsedSec,
          attempt: activeWin?.attempt ?? meta.attempt,
          maxAttempts: activeWin?.maxAttempts ?? meta.maxAttempts,
          permRetry: activeWin?.permRetry ?? meta.permRetry,
          summaryText: activeWin?.summaryText ?? null,
          screenshotBase64: snap.screenshotBase64,
          screenshotAt: snap.screenshotAt,
          logs: ctrl.getLogs(200),
        })
      } else {
        workerCards.push({
          workerId,
          workerIndex: i,
          profileDirName,
          active: false,
          status: 'IDLE',
          windowId: null,
          windowNumber: null,
          windowRange: null,
          runLabel: null,
          modelName: 'Gemini 3.8 Flash',
          stage: 'idle',
          tokens: null,
          elapsedSec: 0,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          summaryText: null,
          screenshotBase64: null,
          screenshotAt: null,
          logs: [],
        })
      }
    }

    const activeWorkersCount = workerCards.filter((w) => w.active).length
    const doneCount = this.windows.filter((w) => w.status === 'DONE').length
    const queuedCount = this.windows.filter((w) => w.status === 'QUEUED').length
    const failedCount = this.windows.filter(
      (w) => w.status === 'FAILED' || w.status === 'STOPPED',
    ).length
    const needsAttentionCount = this.windows.filter((w) => w.status === 'NEEDS_ATTENTION').length
    const elapsedSec =
      this.startedAt && this.active
        ? Math.round((Date.now() - this.startedAt) / 1000)
        : this.windows.reduce((acc, w) => Math.max(acc, w.elapsedSec || 0), 0)

    return {
      active: this.active,
      paused: this.paused,
      scanId: this.scanId,
      username: this.username,
      minuteInput: this.minuteInput,
      concurrency: this.concurrency,
      measuredTokenRate: this.measuredTokenRate,
      startedAt: this.startedAt,
      elapsedSec,
      activeWorkersCount,
      doneCount,
      queuedCount,
      failedCount,
      needsAttentionCount,
      totalWindows: this.windows.length,
      ramUsedPercent: readSystemRamUsedPercent(),
      freeDiskGb: readFreeDiskGb(),
      resourceWarning: this.resourceWarning,
      workers: workerCards,
      windows: this.windows,
      mergedReport: this.getMergedReport(),
    }
  }
}

const globalForParallelStudio = globalThis as unknown as {
  __cmtStudioParallelManager?: StudioParallelManager
}

if (globalForParallelStudio.__cmtStudioParallelManager) {
  Object.setPrototypeOf(
    globalForParallelStudio.__cmtStudioParallelManager,
    StudioParallelManager.prototype,
  )
}

export const studioParallelManager =
  globalForParallelStudio.__cmtStudioParallelManager ||
  (globalForParallelStudio.__cmtStudioParallelManager = new StudioParallelManager())
