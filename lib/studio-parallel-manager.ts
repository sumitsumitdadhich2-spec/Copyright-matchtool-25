import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { DATA_DIR, MEDIA_DIR } from './paths'
import { getScan, saveScan } from './store'
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
  | 'WAITING_FOR_WORKER'
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

export type ParallelLogLevel = 'INFO' | 'SUCCESS' | 'RETRY' | '403' | 'ERROR' | 'STOPPED'

export interface ParallelCombinedLogEntry {
  seq: number
  t: number
  elapsedSec: number
  scanId: string
  scanName: string
  workerId: string // "W01".."W10" or "SYS"
  windowId: string | null
  windowNumber: number | null
  windowRange: string | null
  level: ParallelLogLevel
  step: string
  message: string
}

export interface ParallelResourceSnapshot {
  t: number
  elapsedSec: number
  ramUsedPercent: number
  freeDiskGb: number
  activeWorkers: number
  slotsInUse: number
  totalSlots: number
  note?: string
}

export interface ParallelSlotPoolSummary {
  totalSlots: number
  inUseSlots: number
  byScan: Array<{
    scanId: string
    scanLabel: string
    count: number
  }>
  summaryText: string // e.g. "slots: 4/10 in use (Scan A: 2, Scan B: 2)"
}

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
  notFoundCount?: number
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
  leasedByScanId: string | null
  leasedByScanLabel: string | null
  leasedByOtherScan: boolean
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
  waitingForWorkerSlots: boolean
  scanId: string
  scanName: string
  username: string | null
  minuteInput: string
  concurrency: number
  measuredTokenRate: number | null
  startedAt: number | null
  finishedAt: number | null
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
  slotPool: ParallelSlotPoolSummary
  workers: ParallelWorkerCardSnapshot[]
  windows: ParallelWindowState[]
  mergedReport: ParallelMergedReport | null
  combinedLogs: ParallelCombinedLogEntry[]
  totalLogLinesOnDisk: number
  resourceSnapshots: ParallelResourceSnapshot[]
}

interface PersistedParallelState {
  version: 2
  scanId: string
  scanName: string
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
  finishedAt: number | null
  updatedAt: number
  windows: ParallelWindowState[]
  resourceSnapshots?: ParallelResourceSnapshot[]
}

const LEGACY_PARALLEL_STATE_FILE = path.join(DATA_DIR, 'studio-parallel-state.json')
const BASE_PROFILE_NAME = 'studio-chrome-profile'
const MAX_LOG_FILE_BYTES = 50 * 1024 * 1024 // 50 MB rotation cap
const UI_COMBINED_LOG_LIMIT = 2000

export function readSystemRamUsedPercent(): number {
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

export function readFreeDiskGb(): number {
  try {
    const stat = fs.statfsSync(DATA_DIR)
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    return Math.round((freeBytes / 1024 ** 3) * 10) / 10
  } catch {
    return 50
  }
}

export function resolveScanDisplayLabel(scanId: string): string {
  if (!scanId || scanId === 'default') return 'Default Scan'
  try {
    const scan = getScan(scanId)
    if (scan) {
      const title =
        scan.customName?.trim() ||
        scan.movieName?.replace(/\.[^.]+$/, '') ||
        scan.shortName?.replace(/\.[^.]+$/, '') ||
        ''
      const shortId = scanId.slice(0, 6)
      return title ? `${title.slice(0, 22)} (#${shortId})` : `Scan #${shortId}`
    }
  } catch {
    /* ignore */
  }
  return `Scan #${scanId.slice(0, 8)}`
}

/**
 * Clone base profile `data/studio-chrome-profile` into `data/studio-chrome-profile-wXX`
 * excluding SingletonLock/SingletonCookie/SingletonSocket and heavy browser cache folders.
 */
function syncWorkerProfileFromBase(slotIndex: number): string {
  const workerSuffix = String(slotIndex).padStart(2, '0')
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
  if (s.includes('permission denied') || s.includes('403 ->') || s.includes('403 permission_denied')) {
    return '403_WAIT'
  }
  if (s.includes('retry [')) return 'RETRYING'
  if (s.includes('validate') || s.includes('copy')) return 'VALIDATING'
  if (s.includes('running ')) return 'RUNNING'
  return 'SETUP'
}

export function classifyParallelLogLevel(
  rawLevel: 'info' | 'warn' | 'error' | 'success',
  step: string,
  detail?: string,
): ParallelLogLevel {
  const combined = `${step || ''} ${detail || ''}`.toLowerCase()
  if (
    combined.includes('403') ||
    combined.includes('permission_denied') ||
    combined.includes('permission denied') ||
    combined.includes('hard reset') ||
    combined.includes('browser restart')
  ) {
    return '403'
  }
  if (
    combined.includes('stopped by user') ||
    combined.includes('stopping') ||
    combined.includes('window stopped') ||
    combined.includes('scan stopped')
  ) {
    return 'STOPPED'
  }
  if (
    combined.includes('retry [') ||
    combined.includes('retrying') ||
    combined.includes('split') ||
    combined.includes('context-limit')
  ) {
    return 'RETRY'
  }
  if (rawLevel === 'error' || combined.includes('error [') || combined.includes('failed')) {
    return 'ERROR'
  }
  if (rawLevel === 'success' || combined.includes('success [') || combined.includes('done by')) {
    return 'SUCCESS'
  }
  return 'INFO'
}

// ============================================================================
// GLOBAL PROFILE SLOT POOL (studio-chrome-profile-w01 .. wNN)
// Ensures two scans NEVER use the same worker profile slot at the same time,
// and total active workers across all scans never exceed maxTotalSlots (default 10).
// ============================================================================

export interface ProfileSlotEntry {
  slotIndex: number // 1..20
  workerId: string // "W01".."W20"
  profileDirName: string // "studio-chrome-profile-w01"
  controller: StudioBrowserController
  leasedByScanId: string | null
  leasedByScanLabel: string | null
  leasedWindowId: string | null
  leasedWindowNumber: number | null
  leasedWindowRange: string | null
  leasedAt: number | null
  everLaunched: boolean
}

class GlobalProfileSlotPool {
  private slots = new Map<number, ProfileSlotEntry>()
  private maxTotalSlots: number = DEFAULT_STUDIO_CONCURRENCY
  private lastLaunchAt = 0

  public setMaxTotalSlots(limit: number) {
    if (Number.isFinite(limit) && limit >= 1) {
      this.maxTotalSlots = Math.max(1, Math.min(20, Math.round(limit)))
    }
  }

  public getMaxTotalSlots(): number {
    return this.maxTotalSlots
  }

  public getOrCreateSlot(slotIndex: number): ProfileSlotEntry {
    let slot = this.slots.get(slotIndex)
    if (!slot) {
      const workerId = `W${String(slotIndex).padStart(2, '0')}`
      const profileDirName = syncWorkerProfileFromBase(slotIndex)
      const controller = new StudioBrowserController({
        profileDirName,
        workerTag: `[${workerId}]`,
      })
      slot = {
        slotIndex,
        workerId,
        profileDirName,
        controller,
        leasedByScanId: null,
        leasedByScanLabel: null,
        leasedWindowId: null,
        leasedWindowNumber: null,
        leasedWindowRange: null,
        leasedAt: null,
        everLaunched: false,
      }
      this.slots.set(slotIndex, slot)
    }
    return slot
  }

  /**
   * Try to lease a free profile slot in [1 .. totalPoolLimit].
   * Prefers `preferredSlotIndex` if free (so a scan reuses its warm browser),
   * otherwise picks the lowest free slot index.
   * Returns null if all slots in the pool are currently leased.
   */
  public tryAcquireSlot(params: {
    scanId: string
    scanLabel: string
    windowId: string
    windowNumber: number
    windowRange: string
    preferredSlotIndex?: number | null
    poolLimit?: number
  }): ProfileSlotEntry | null {
    const limit = Math.max(1, Math.min(20, params.poolLimit || this.maxTotalSlots))
    let inUseCount = 0
    for (const s of this.slots.values()) {
      if (s.leasedByScanId !== null) {
        inUseCount += 1
      }
    }
    if (inUseCount >= limit) {
      return null
    }

    const candidates: number[] = []
    if (
      params.preferredSlotIndex &&
      params.preferredSlotIndex >= 1 &&
      params.preferredSlotIndex <= limit
    ) {
      candidates.push(params.preferredSlotIndex)
    }
    for (let i = 1; i <= limit; i++) {
      if (!candidates.includes(i)) candidates.push(i)
    }

    for (const idx of candidates) {
      const slot = this.getOrCreateSlot(idx)
      if (slot.leasedByScanId === null) {
        slot.leasedByScanId = params.scanId
        slot.leasedByScanLabel = params.scanLabel
        slot.leasedWindowId = params.windowId
        slot.leasedWindowNumber = params.windowNumber
        slot.leasedWindowRange = params.windowRange
        slot.leasedAt = Date.now()
        return slot
      }
    }
    return null
  }

  /**
   * Enforce a global stagger when a slot launches Chrome for the first time
   * so multiple scans starting concurrently never spike CPU/disk at the same second.
   */
  public reserveLaunchStaggerDelayMs(slotIndex: number): number {
    const slot = this.getOrCreateSlot(slotIndex)
    if (slot.everLaunched) return 0
    slot.everLaunched = true
    const now = Date.now()
    const STAGGER_MS = 10_000
    if (this.lastLaunchAt === 0 || now >= this.lastLaunchAt + STAGGER_MS) {
      this.lastLaunchAt = now
      return 0
    }
    const nextAt = this.lastLaunchAt + STAGGER_MS
    this.lastLaunchAt = nextAt
    return Math.max(0, nextAt - now)
  }

  public releaseSlot(slotIndex: number, scanId?: string) {
    const slot = this.slots.get(slotIndex)
    if (!slot) return
    if (scanId && slot.leasedByScanId && slot.leasedByScanId !== scanId) {
      return
    }
    slot.controller.setStepLogListener(undefined)
    slot.controller.setScanContextTag('')
    slot.leasedByScanId = null
    slot.leasedByScanLabel = null
    slot.leasedWindowId = null
    slot.leasedWindowNumber = null
    slot.leasedWindowRange = null
    slot.leasedAt = null
  }

  public releaseAllSlotsForScan(scanId: string) {
    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId === scanId) {
        this.releaseSlot(slot.slotIndex, scanId)
      }
    }
  }

  public getLeasedSlotsForScan(scanId: string): ProfileSlotEntry[] {
    const out: ProfileSlotEntry[] = []
    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId === scanId) {
        out.push(slot)
      }
    }
    return out.sort((a, b) => a.slotIndex - b.slotIndex)
  }

  public getSummary(poolLimit?: number): ParallelSlotPoolSummary {
    const totalSlots = Math.max(1, Math.min(20, poolLimit || this.maxTotalSlots))
    const byScanMap = new Map<string, { scanId: string; scanLabel: string; count: number }>()
    let inUseSlots = 0

    for (const slot of this.slots.values()) {
      if (slot.leasedByScanId) {
        inUseSlots += 1
        const existing = byScanMap.get(slot.leasedByScanId)
        if (existing) {
          existing.count += 1
        } else {
          byScanMap.set(slot.leasedByScanId, {
            scanId: slot.leasedByScanId,
            scanLabel: slot.leasedByScanLabel || resolveScanDisplayLabel(slot.leasedByScanId),
            count: 1,
          })
        }
      }
    }

    const byScan = Array.from(byScanMap.values())
    const breakdown =
      byScan.length > 0
        ? ` (${byScan.map((s) => `${s.scanLabel}: ${s.count}`).join(', ')})`
        : ''
    const summaryText = `slots: ${inUseSlots}/${totalSlots} in use${breakdown}`

    return {
      totalSlots,
      inUseSlots,
      byScan,
      summaryText,
    }
  }
}

const globalForParallelStudio = globalThis as unknown as {
  __cmtGlobalProfileSlotPool?: GlobalProfileSlotPool
  __cmtStudioParallelManagers?: Map<string, StudioParallelManager>
  __cmtStudioParallelRestored?: boolean
}

export const globalProfileSlotPool: GlobalProfileSlotPool =
  globalForParallelStudio.__cmtGlobalProfileSlotPool ||
  (globalForParallelStudio.__cmtGlobalProfileSlotPool = new GlobalProfileSlotPool())

// ============================================================================
// PER-SCAN STUDIO PARALLEL MANAGER
// Each scanId has its own StudioParallelManager instance, its own state file
// `data/scans/<scanId>/parallel-state.json`, and its own JSONL log file
// `data/scans/<scanId>/parallel-log.jsonl`.
// ============================================================================

export class StudioParallelManager {
  public readonly scanId: string
  private scanName: string
  private windows: ParallelWindowState[] = []
  private active = false
  private paused = false
  private stoppingAll = false
  private waitingForWorkerSlots = false
  private stoppedWindowIds = new Set<string>()
  private username: string | null = null
  private minuteInput: string = DEFAULT_STUDIO_MINUTE_INPUT
  private concurrency: number = DEFAULT_STUDIO_CONCURRENCY
  private maxTotalPoolSlots: number = DEFAULT_STUDIO_CONCURRENCY
  private measuredTokenRate: number | null = null
  private startedAt: number | null = null
  private finishedAt: number | null = null
  private shortLocalPath: string | null = null
  private shortYoutubeUrl: string | null = null
  private shortDriveFileName: string | null = null
  private shortDurationSec: number = 150
  private movieLocalPath: string | null = null
  private movieDriveFileName: string | null = null
  private movieDurationSec: number = 6600
  private resourceWarning: string | null = null
  private combinedLogs: ParallelCombinedLogEntry[] = []
  private nextLogSeq = 1
  private totalLogLinesOnDisk = 0
  private resourceSnapshots: ParallelResourceSnapshot[] = []
  private lastResourceSnapAt = 0
  private onMatchCallback?: (windowState: ParallelWindowState, matches: ChunkMatch[]) => Promise<void>
  private onLogCallback?: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void

  constructor(scanId: string) {
    this.scanId = scanId || 'default'
    this.scanName = resolveScanDisplayLabel(this.scanId)
    this.tryRestorePersistedState()
    this.tryLoadCombinedLogsFromDisk()
  }

  public getScanDir(): string {
    return path.join(DATA_DIR, 'scans', this.scanId)
  }

  public getStateFilePath(): string {
    return path.join(this.getScanDir(), 'parallel-state.json')
  }

  public getLogFilePath(): string {
    return path.join(this.getScanDir(), 'parallel-log.jsonl')
  }

  public getRotatedLogFilePath(): string {
    return path.join(this.getScanDir(), 'parallel-log.1.jsonl')
  }

  private refreshScanMetadataFromStore() {
    this.scanName = resolveScanDisplayLabel(this.scanId)
    if (this.scanId && this.scanId !== 'default') {
      try {
        const scan = getScan(this.scanId)
        if (scan) {
          if (scan.studioMinuteInput && (!this.windows.length || !this.active)) {
            this.minuteInput = scan.studioMinuteInput
          }
          if (
            typeof scan.studioParallelConcurrency === 'number' &&
            scan.studioParallelConcurrency >= 1 &&
            !this.active
          ) {
            this.concurrency = scan.studioParallelConcurrency
          }
          if (scan.shortDuration && scan.shortDuration > 0) {
            this.shortDurationSec = scan.shortDuration
          }
          if (scan.movieDuration && scan.movieDuration > 0) {
            this.movieDurationSec = scan.movieDuration
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private tryRestorePersistedState() {
    try {
      const primaryFile = this.getStateFilePath()
      const legacyScanWindowsFile = path.join(this.getScanDir(), 'parallel-windows.json')
      let raw: Partial<PersistedParallelState> | null = null

      if (fs.existsSync(primaryFile)) {
        raw = JSON.parse(fs.readFileSync(primaryFile, 'utf8'))
      } else if (fs.existsSync(legacyScanWindowsFile)) {
        raw = JSON.parse(fs.readFileSync(legacyScanWindowsFile, 'utf8'))
      } else if (fs.existsSync(LEGACY_PARALLEL_STATE_FILE)) {
        // One-time migration from legacy single global state file if it belonged to this scanId
        const legacyGlobal = JSON.parse(fs.readFileSync(LEGACY_PARALLEL_STATE_FILE, 'utf8'))
        if (legacyGlobal && legacyGlobal.scanId === this.scanId) {
          raw = legacyGlobal
        }
      }

      if (raw && Array.isArray(raw.windows) && raw.windows.length > 0) {
        this.username = raw.username || 'admin'
        this.scanName = raw.scanName || resolveScanDisplayLabel(this.scanId)
        this.minuteInput = raw.minuteInput || DEFAULT_STUDIO_MINUTE_INPUT
        this.concurrency = raw.concurrency || DEFAULT_STUDIO_CONCURRENCY
        this.shortLocalPath = raw.shortLocalPath ?? null
        this.shortYoutubeUrl = raw.shortYoutubeUrl ?? null
        this.shortDriveFileName = raw.shortDriveFileName ?? null
        this.shortDurationSec = raw.shortDurationSec || 150
        this.movieLocalPath = raw.movieLocalPath ?? null
        this.movieDriveFileName = raw.movieDriveFileName ?? null
        this.movieDurationSec = raw.movieDurationSec || 6600
        this.startedAt = raw.startedAt || null
        this.finishedAt = raw.finishedAt || null
        this.resourceSnapshots = Array.isArray(raw.resourceSnapshots) ? raw.resourceSnapshots : []

        // Any window that was in-flight when container restarted goes back to QUEUED; DONE stays DONE
        this.windows = raw.windows.map((w) => {
          if (
            w.status === 'SETUP' ||
            w.status === 'RUNNING' ||
            w.status === 'VALIDATING' ||
            w.status === 'RETRYING' ||
            w.status === '403_WAIT' ||
            w.status === 'WAITING_FOR_WORKER'
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
      }

      this.refreshScanMetadataFromStore()
    } catch {
      /* ignore corrupt state file */
    }
  }

  private tryLoadCombinedLogsFromDisk() {
    try {
      const logFile = this.getLogFilePath()
      if (!fs.existsSync(logFile)) return
      const content = fs.readFileSync(logFile, 'utf8')
      const lines = content.split('\n').filter((l) => l.trim().length > 0)
      this.totalLogLinesOnDisk = lines.length
      const tail = lines.slice(-UI_COMBINED_LOG_LIMIT)
      const parsed: ParallelCombinedLogEntry[] = []
      for (const line of tail) {
        try {
          const obj = JSON.parse(line) as ParallelCombinedLogEntry
          if (obj && typeof obj.t === 'number') {
            parsed.push(obj)
            if (typeof obj.seq === 'number' && obj.seq >= this.nextLogSeq) {
              this.nextLogSeq = obj.seq + 1
            }
          }
        } catch {
          /* skip malformed line */
        }
      }
      this.combinedLogs = parsed
    } catch {
      /* ignore */
    }
  }

  /**
   * Read ALL combined logs from disk (including rotated .1.jsonl if present) for full PDF export.
   */
  public readAllCombinedLogsFromDisk(): ParallelCombinedLogEntry[] {
    const out: ParallelCombinedLogEntry[] = []
    const files = [this.getRotatedLogFilePath(), this.getLogFilePath()]
    for (const file of files) {
      try {
        if (!fs.existsSync(file)) continue
        const raw = fs.readFileSync(file, 'utf8')
        const lines = raw.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed) as ParallelCombinedLogEntry
            if (parsed && typeof parsed.t === 'number') {
              out.push(parsed)
            }
          } catch {
            /* skip malformed line */
          }
        }
      } catch {
        /* ignore read error */
      }
    }
    if (out.length === 0 && this.combinedLogs.length > 0) {
      return [...this.combinedLogs]
    }
    return out.sort((a, b) => a.t - b.t || a.seq - b.seq)
  }

  public appendCombinedLog(params: {
    workerId: string
    windowId?: string | null
    windowNumber?: number | null
    windowRange?: string | null
    level: ParallelLogLevel
    step: string
    message: string
    t?: number
  }): ParallelCombinedLogEntry {
    const now = params.t || Date.now()
    const elapsedSec = this.startedAt ? Math.max(0, Math.round((now - this.startedAt) / 1000)) : 0
    const entry: ParallelCombinedLogEntry = {
      seq: this.nextLogSeq++,
      t: now,
      elapsedSec,
      scanId: this.scanId,
      scanName: this.scanName,
      workerId: params.workerId || 'SYS',
      windowId: params.windowId ?? null,
      windowNumber: params.windowNumber ?? null,
      windowRange: params.windowRange ?? null,
      level: params.level,
      step: params.step,
      message: params.message,
    }

    this.combinedLogs.push(entry)
    if (this.combinedLogs.length > UI_COMBINED_LOG_LIMIT) {
      this.combinedLogs.splice(0, this.combinedLogs.length - UI_COMBINED_LOG_LIMIT)
    }
    this.totalLogLinesOnDisk += 1

    try {
      const scanDir = this.getScanDir()
      fs.mkdirSync(scanDir, { recursive: true })
      const logFile = this.getLogFilePath()
      if (this.totalLogLinesOnDisk % 200 === 0 && fs.existsSync(logFile)) {
        const st = fs.statSync(logFile)
        if (st.size >= MAX_LOG_FILE_BYTES) {
          const rotated = this.getRotatedLogFilePath()
          try {
            fs.renameSync(logFile, rotated)
          } catch {
            /* ignore rotation race */
          }
        }
      }
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* ignore disk append error */
    }

    return entry
  }

  private recordResourceSnapshotIfNeeded(force = false, note?: string) {
    const now = Date.now()
    if (!force && now - this.lastResourceSnapAt < 15_000) return
    this.lastResourceSnapAt = now

    const slotSummary = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
    const activeForThisScan = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId).length
    const snap: ParallelResourceSnapshot = {
      t: now,
      elapsedSec: this.startedAt ? Math.max(0, Math.round((now - this.startedAt) / 1000)) : 0,
      ramUsedPercent: readSystemRamUsedPercent(),
      freeDiskGb: readFreeDiskGb(),
      activeWorkers: activeForThisScan,
      slotsInUse: slotSummary.inUseSlots,
      totalSlots: slotSummary.totalSlots,
      ...(note ? { note } : {}),
    }
    this.resourceSnapshots.push(snap)
    if (this.resourceSnapshots.length > 300) {
      this.resourceSnapshots.splice(0, this.resourceSnapshots.length - 300)
    }
  }

  private persistStateToDisk() {
    try {
      const scanDir = this.getScanDir()
      fs.mkdirSync(scanDir, { recursive: true })
      const payload: PersistedParallelState = {
        version: 2,
        scanId: this.scanId,
        scanName: this.scanName,
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
        finishedAt: this.finishedAt,
        updatedAt: Date.now(),
        windows: this.windows,
        resourceSnapshots: this.resourceSnapshots,
      }
      const jsonStr = JSON.stringify(payload, null, 2)
      fs.writeFileSync(this.getStateFilePath(), jsonStr, 'utf8')
      fs.writeFileSync(path.join(scanDir, 'parallel-windows.json'), jsonStr, 'utf8')

      const report = this.getMergedReport()
      if (report) {
        fs.writeFileSync(
          path.join(scanDir, 'parallel-merged-report.json'),
          JSON.stringify(report, null, 2),
          'utf8',
        )
        fs.writeFileSync(
          path.join(scanDir, 'parallel-merged-report.txt'),
          report.formattedTxt,
          'utf8',
        )
      }
    } catch {
      /* ignore disk write error */
    }
  }

  private persistMinuteInputOnScanRecord(minuteInput: string, concurrency: number) {
    if (!this.scanId || this.scanId === 'default') return
    try {
      const scan = getScan(this.scanId)
      if (scan) {
        scan.studioMinuteInput = minuteInput
        scan.studioParallelConcurrency = concurrency
        saveScan(scan)
      }
    } catch {
      /* ignore */
    }
  }

  public isRunning(): boolean {
    return this.active
  }

  public getWindows(): ParallelWindowState[] {
    return this.windows
  }

  public getResourceSnapshots(): ParallelResourceSnapshot[] {
    return this.resourceSnapshots
  }

  public getMergedReport(): ParallelMergedReport | null {
    if (this.windows.length === 0) return null
    return mergeParallelWindowResults({
      windows: this.windows,
    })
  }

  /**
   * Build / preview the windows from minuteInput for THIS scan and persist config.
   */
  public previewPlan(minuteInput?: string, concurrency?: number, movieDurationSec?: number): ParallelWindowState[] {
    this.refreshScanMetadataFromStore()
    if (minuteInput !== undefined && minuteInput.trim()) {
      this.minuteInput = minuteInput.trim()
    }
    if (concurrency !== undefined && Number.isFinite(Number(concurrency))) {
      this.concurrency = Math.max(1, Math.min(20, Math.round(Number(concurrency))))
    }
    if (movieDurationSec !== undefined && movieDurationSec > 0) {
      this.movieDurationSec = movieDurationSec
    }

    this.persistMinuteInputOnScanRecord(this.minuteInput, this.concurrency)

    const { windows } = buildParallelWindowsFromMinuteInput(this.minuteInput, this.movieDurationSec)
    if (!this.active) {
      this.windows = windows.map((w) => ({
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
      this.persistStateToDisk()
    }
    return this.windows
  }

  private resolveMediaPaths(): {
    shortLocalPath: string | null
    movieLocalPath: string | null
  } {
    if (this.scanId && this.scanId !== 'default') {
      const dir = path.join(MEDIA_DIR, this.scanId)
      const shortP = path.join(dir, 'short.mp4')
      const movie360 = path.join(dir, 'movie_360p.mp4')
      const movieRaw = path.join(dir, 'movie.mp4')
      return {
        shortLocalPath: fs.existsSync(shortP) ? shortP : null,
        movieLocalPath: fs.existsSync(movie360)
          ? movie360
          : fs.existsSync(movieRaw)
            ? movieRaw
            : null,
      }
    }
    return { shortLocalPath: null, movieLocalPath: null }
  }

  /**
   * Start or resume a Parallel Window Scan for THIS scanId using the Global Profile Slot Pool.
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
  }): Promise<{ totalWindows: number; concurrency: number; scanId: string }> {
    if (this.active) {
      throw new Error(`Parallel Window Scan is already running for ${this.scanName}`)
    }

    this.refreshScanMetadataFromStore()
    const cfg = await loadStudioUserConfig(params.username)
    this.username = params.username

    if (params.minuteInput !== undefined && params.minuteInput.trim()) {
      this.minuteInput = params.minuteInput.trim()
    } else if (!this.minuteInput) {
      this.minuteInput = cfg.studioMinuteInput || DEFAULT_STUDIO_MINUTE_INPUT
    }

    const globalMaxSlots = Math.max(
      1,
      Math.min(20, Number(cfg.studioConcurrency || DEFAULT_STUDIO_CONCURRENCY)),
    )
    this.maxTotalPoolSlots = globalMaxSlots
    globalProfileSlotPool.setMaxTotalSlots(globalMaxSlots)

    this.concurrency = Math.max(
      1,
      Math.min(
        20,
        Number(params.concurrency ?? this.concurrency ?? cfg.studioConcurrency ?? DEFAULT_STUDIO_CONCURRENCY),
      ),
    )

    this.persistMinuteInputOnScanRecord(this.minuteInput, this.concurrency)

    this.measuredTokenRate = cfg.studioMeasuredTokenRate ?? null
    if (params.onWindowMatches) this.onMatchCallback = params.onWindowMatches
    if (params.onLog) this.onLogCallback = params.onLog

    const mediaResolved = this.resolveMediaPaths()
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
      this.finishedAt = null
    } else {
      for (const w of this.windows) {
        if (w.status !== 'DONE' && w.status !== 'SKIPPED') {
          w.status = 'QUEUED'
          w.workerId = null
          w.stage = 'queued'
          w.error = null
        }
      }
      if (!this.startedAt) this.startedAt = Date.now()
      this.finishedAt = null
    }

    this.active = true
    this.paused = false
    this.stoppingAll = false
    this.waitingForWorkerSlots = false
    this.stoppedWindowIds.clear()
    this.recordResourceSnapshotIfNeeded(true, 'Parallel scan started')
    this.persistStateToDisk()

    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'INFO',
      step: 'parallel scan start',
      message: `Started Parallel Window Scan for ${this.scanName} (${this.windows.length} windows, scan concurrency=${this.concurrency}, global pool max=${this.maxTotalPoolSlots}, minutes="${this.minuteInput}")`,
    })

    this.runWorkerPoolLoop().catch((err) => {
      const msg = (err as Error).message
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'ERROR',
        step: 'worker pool error',
        message: `Parallel worker pool error: ${msg}`,
      })
      this.onLogCallback?.('error', `Parallel worker pool error: ${msg}`)
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
      .filter(
        (w) =>
          (w.status === 'QUEUED' || w.status === 'WAITING_FOR_WORKER') &&
          !this.stoppedWindowIds.has(w.id),
      )
      .sort((a, b) => a.priorityRank - b.priorityRank || a.windowNumber - b.windowNumber)
    return candidates[0] || null
  }

  private async runWorkerPoolLoop(): Promise<void> {
    const workerCount = this.concurrency
    const workerPromises: Promise<void>[] = []

    for (let laneIdx = 1; laneIdx <= workerCount; laneIdx++) {
      workerPromises.push(this.runSingleWorkerLane(laneIdx))
    }

    await Promise.allSettled(workerPromises)
    globalProfileSlotPool.releaseAllSlotsForScan(this.scanId)
    this.active = false
    this.waitingForWorkerSlots = false
    this.finishedAt = Date.now()
    this.recordResourceSnapshotIfNeeded(true, 'Parallel scan finished')
    this.persistStateToDisk()

    const doneCount = this.windows.filter((w) => w.status === 'DONE').length
    const failedCount = this.windows.filter((w) => w.status === 'FAILED').length
    this.appendCombinedLog({
      workerId: 'SYS',
      level: failedCount > 0 ? 'ERROR' : 'SUCCESS',
      step: 'parallel scan finished',
      message: `Parallel Window Scan finished for ${this.scanName}: ${doneCount}/${this.windows.length} DONE, ${failedCount} FAILED`,
    })
  }

  private async runSingleWorkerLane(laneIndex: number): Promise<void> {
    let preferredSlotIndex: number | null = laneIndex <= this.maxTotalPoolSlots ? laneIndex : null

    while (!this.stoppingAll) {
      while (this.paused && !this.stoppingAll) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (this.stoppingAll) break

      const candidateWin = this.pullNextQueuedWindow()
      if (!candidateWin) {
        const anyInFlight = this.windows.some(
          (w) =>
            w.status === 'SETUP' ||
            w.status === 'RUNNING' ||
            w.status === 'VALIDATING' ||
            w.status === 'RETRYING' ||
            w.status === '403_WAIT',
        )
        const anyQueued = this.windows.some(
          (w) => w.status === 'QUEUED' || w.status === 'WAITING_FOR_WORKER',
        )
        if (!anyQueued && !anyInFlight) {
          break
        }
        if (!anyQueued && anyInFlight) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
      }
      if (!candidateWin) break

      // Resource check before leasing a slot and starting window (RAM & Disk)
      const freeDiskGb = readFreeDiskGb()
      if (freeDiskGb < 5) {
        this.resourceWarning = `WARN: Low disk space (${freeDiskGb} GB free < 5 GB)`
        this.recordResourceSnapshotIfNeeded(true, this.resourceWarning)
        this.appendCombinedLog({
          workerId: 'SYS',
          windowId: candidateWin.id,
          windowNumber: candidateWin.windowNumber,
          windowRange: `${candidateWin.startFormatted}–${candidateWin.endFormatted}`,
          level: 'ERROR',
          step: 'WARN [low-disk]',
          message: this.resourceWarning,
        })
      }

      let ramPct = readSystemRamUsedPercent()
      while (ramPct > 85 && !this.stoppingAll) {
        this.resourceWarning = `WARN: High RAM usage (${ramPct}% > 85%) — throttling new worker start`
        this.recordResourceSnapshotIfNeeded(true, this.resourceWarning)
        await new Promise((r) => setTimeout(r, 3000))
        ramPct = readSystemRamUsedPercent()
        const activeCount = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId).length
        if (activeCount === 0) break
      }

      // Lease a free worker slot from the GLOBAL Profile Slot Pool
      let leasedSlot: ProfileSlotEntry | null = null
      let loggedWaitingForSlot = false

      while (!this.stoppingAll && !this.paused) {
        const checkWin = this.pullNextQueuedWindow()
        if (!checkWin) break

        leasedSlot = globalProfileSlotPool.tryAcquireSlot({
          scanId: this.scanId,
          scanLabel: this.scanName,
          windowId: checkWin.id,
          windowNumber: checkWin.windowNumber,
          windowRange: `${checkWin.startFormatted}–${checkWin.endFormatted}`,
          preferredSlotIndex,
          poolLimit: this.maxTotalPoolSlots,
        })

        if (leasedSlot) {
          this.waitingForWorkerSlots = false
          preferredSlotIndex = leasedSlot.slotIndex
          break
        }

        // All global profile slots are currently in use (e.g. by another scan or this scan's other workers)
        this.waitingForWorkerSlots = true
        if (checkWin.status === 'QUEUED') {
          checkWin.status = 'WAITING_FOR_WORKER'
          checkWin.stage = 'WAITING FOR WORKER (global slot pool full)'
          checkWin.summaryText = 'WAITING FOR WORKER (slots full)'
        }
        if (!loggedWaitingForSlot) {
          loggedWaitingForSlot = true
          const poolSnap = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
          this.appendCombinedLog({
            workerId: 'SYS',
            windowId: checkWin.id,
            windowNumber: checkWin.windowNumber,
            windowRange: `${checkWin.startFormatted}–${checkWin.endFormatted}`,
            level: 'INFO',
            step: 'WAITING FOR WORKER',
            message: `Waiting for free profile slot (${poolSnap.summaryText})`,
          })
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      if (!leasedSlot) {
        if (this.stoppingAll) break
        continue
      }

      // Re-verify the window to run now that we hold `leasedSlot`
      const nextWin = this.pullNextQueuedWindow()
      if (!nextWin) {
        globalProfileSlotPool.releaseSlot(leasedSlot.slotIndex, this.scanId)
        continue
      }

      // Update slot lease metadata with the exact pulled window
      leasedSlot.leasedWindowId = nextWin.id
      leasedSlot.leasedWindowNumber = nextWin.windowNumber
      leasedSlot.leasedWindowRange = `${nextWin.startFormatted}–${nextWin.endFormatted}`

      try {
        // Global stagger on first browser launch for this slot
        const staggerMs = globalProfileSlotPool.reserveLaunchStaggerDelayMs(leasedSlot.slotIndex)
        if (staggerMs > 0) {
          const waitSec = Math.round(staggerMs / 1000)
          this.appendCombinedLog({
            workerId: leasedSlot.workerId,
            windowId: nextWin.id,
            windowNumber: nextWin.windowNumber,
            windowRange: `${nextWin.startFormatted}–${nextWin.endFormatted}`,
            level: 'INFO',
            step: 'stagger wait',
            message: `Waiting ${waitSec}s stagger before launching ${leasedSlot.workerId} (${leasedSlot.profileDirName})`,
          })
          const waitEnd = Date.now() + staggerMs
          while (Date.now() < waitEnd && !this.stoppingAll) {
            await new Promise((r) => setTimeout(r, 500))
          }
        }

        if (this.stoppingAll) {
          break
        }

        await this.executeWindowOnSlot(leasedSlot, nextWin)

        if (nextWin.status === 'NEEDS_ATTENTION') {
          this.appendCombinedLog({
            workerId: leasedSlot.workerId,
            windowId: nextWin.id,
            windowNumber: nextWin.windowNumber,
            windowRange: `${nextWin.startFormatted}–${nextWin.endFormatted}`,
            level: 'ERROR',
            step: 'worker halted',
            message: `Halted ${leasedSlot.workerId} due to NEEDS ATTENTION on Window #${nextWin.windowNumber}`,
          })
          break
        }
      } finally {
        globalProfileSlotPool.releaseSlot(leasedSlot.slotIndex, this.scanId)
      }
    }
  }

  private async executeWindowOnSlot(
    slot: ProfileSlotEntry,
    win: ParallelWindowState,
  ): Promise<void> {
    const workerId = slot.workerId
    const ctrl = slot.controller
    const windowRangeStr = `${win.startFormatted}–${win.endFormatted}`
    const jobScanScope = `parallel-${this.scanId}-${win.id}`
    const shortScanTag = `[${this.scanName}]`

    ctrl.clearStop({ scanId: jobScanScope, username: this.username })
    ctrl.setScanContextTag(shortScanTag)

    // Wire real-time step listener so every single step logged by StudioBrowserController
    // is recorded in this scan's Combined Log & parallel-log.jsonl with workerId + scanName + windowRange
    ctrl.setStepLogListener((stepEntry: StudioStepLog) => {
      const classified = classifyParallelLogLevel(stepEntry.level, stepEntry.step, stepEntry.detail)
      const cleanStep = stepEntry.step
        .replace(new RegExp(`^\\[${workerId}\\]\\s*`, 'i'), '')
        .replace(shortScanTag, '')
        .trim()
      const msg = stepEntry.detail ? `${cleanStep}: ${stepEntry.detail}` : cleanStep
      this.appendCombinedLog({
        workerId,
        windowId: win.id,
        windowNumber: win.windowNumber,
        windowRange: windowRangeStr,
        level: classified,
        step: cleanStep,
        message: msg,
        t: stepEntry.t,
      })
      this.recordResourceSnapshotIfNeeded(false)
    })

    win.status = 'SETUP'
    win.workerId = workerId
    win.startedAt = Date.now()
    win.finishedAt = null
    win.error = null
    win.summaryText = `Running on ${workerId} (${slot.profileDirName})...`
    this.persistStateToDisk()

    const cfg = await loadStudioUserConfig(this.username || 'admin')
    const jobLabel = `[${this.scanName}] Window #${win.windowNumber} (${windowRangeStr})`

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
          this.onLogCallback?.(level, `[${workerId}]${shortScanTag} ${msg}`)
        },
      })

      if (result.status === 'shrink_needed') {
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
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'RETRY',
          step: 'window split',
          message: `Split Window #${win.windowNumber} (${windowRangeStr}) into #${half1.windowNumber} (${half1.startFormatted}–${half1.endFormatted}) and #${half2.windowNumber} (${half2.startFormatted}–${half2.endFormatted}) due to context token limit (${result.tokenCount})`,
        })
        this.persistStateToDisk()
        return
      }

      const meta = ctrl.getActiveRunMeta()
      const notFoundMatches = (result.rawText.match(/NOT\s+FOUND\s+IN\s+THIS\s+CHUNK/gi) || []).length
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
      win.notFoundCount = notFoundMatches
      win.stage = 'done'
      win.summaryText =
        result.matches.length > 0 ? `${result.matches.length} matches` : '0 matches'
      this.persistStateToDisk()

      this.appendCombinedLog({
        workerId,
        windowId: win.id,
        windowNumber: win.windowNumber,
        windowRange: windowRangeStr,
        level: 'SUCCESS',
        step: 'window DONE',
        message: `Window #${win.windowNumber} (${windowRangeStr}) DONE in ${win.elapsedSec}s — ${win.matchCount} matches, ${notFoundMatches} notFound, model=${win.modelName}, tokens=${win.tokens ?? 'N/A'}`,
      })

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

      const isUserStop =
        msg === 'STOPPED BY USER' ||
        /stopped by user/i.test(msg) ||
        this.stoppedWindowIds.has(win.id) ||
        this.stoppingAll

      if (isUserStop) {
        if ((win.status as string) !== 'SKIPPED') {
          win.status = 'STOPPED'
          win.stage = 'stopped'
          win.summaryText = 'STOPPED BY USER'
          win.error = 'STOPPED BY USER'
        }
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'STOPPED',
          step: 'window STOPPED',
          message: `Window #${win.windowNumber} (${windowRangeStr}) stopped by user`,
        })
      } else if (msg.startsWith('NEEDS_ATTENTION:')) {
        win.status = 'NEEDS_ATTENTION'
        win.stage = 'needs attention'
        win.summaryText = msg.replace(/^NEEDS_ATTENTION:\s*/, '')
        win.error = msg
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'ERROR',
          step: 'NEEDS ATTENTION',
          message: msg,
        })
      } else {
        win.status = 'FAILED'
        win.stage = 'failed'
        win.summaryText = msg.slice(0, 120)
        win.error = msg
        this.appendCombinedLog({
          workerId,
          windowId: win.id,
          windowNumber: win.windowNumber,
          windowRange: windowRangeStr,
          level: 'ERROR',
          step: 'window FAILED',
          message: `Window #${win.windowNumber} (${windowRangeStr}) failed: ${msg}`,
        })
      }
      this.persistStateToDisk()
    } finally {
      ctrl.setStepLogListener(undefined)
      ctrl.setScanContextTag('')
    }
  }

  public pauseAll() {
    this.paused = true
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      slot.controller.setPaused(true)
    }
    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'INFO',
      step: 'pause all',
      message: `Paused Parallel Window Scan for ${this.scanName}`,
    })
  }

  public resumeAll() {
    this.paused = false
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      slot.controller.setPaused(false)
    }
    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'INFO',
      step: 'resume all',
      message: `Resumed Parallel Window Scan for ${this.scanName}`,
    })
  }

  public stopAll() {
    this.stoppingAll = true
    this.paused = false
    this.waitingForWorkerSlots = false

    // Only stop slots leased by THIS scan! Never touch slots leased by other scans.
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      if (slot.leasedWindowId) {
        const jobScanScope = `parallel-${this.scanId}-${slot.leasedWindowId}`
        slot.controller.requestStop({ scanId: jobScanScope })
      }
      if (!slot.controller.getActiveScanId()) {
        globalProfileSlotPool.releaseSlot(slot.slotIndex, this.scanId)
      }
    }

    for (const w of this.windows) {
      if (w.status === 'QUEUED' || w.status === 'WAITING_FOR_WORKER') {
        w.status = 'STOPPED'
        w.stage = 'stopped'
        w.summaryText = 'STOPPED BY USER'
      }
    }
    this.active = false
    this.finishedAt = Date.now()
    this.persistStateToDisk()

    this.appendCombinedLog({
      workerId: 'SYS',
      level: 'STOPPED',
      step: 'stop all',
      message: `Stopped all parallel windows for ${this.scanName}`,
    })
  }

  public stopWindow(windowId: string) {
    this.stoppedWindowIds.add(windowId)
    const win = this.windows.find((w) => w.id === windowId)
    if (!win) return

    if (win.status === 'QUEUED' || win.status === 'WAITING_FOR_WORKER') {
      win.status = 'STOPPED'
      win.stage = 'stopped'
      win.summaryText = 'STOPPED BY USER'
      this.persistStateToDisk()
      this.appendCombinedLog({
        workerId: 'SYS',
        windowId: win.id,
        windowNumber: win.windowNumber,
        windowRange: `${win.startFormatted}–${win.endFormatted}`,
        level: 'STOPPED',
        step: 'stop window',
        message: `Stopped queued Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted})`,
      })
      return
    }

    const jobScanScope = `parallel-${this.scanId}-${win.id}`
    const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
    for (const slot of leased) {
      if (slot.leasedWindowId === windowId) {
        slot.controller.requestStop({ scanId: jobScanScope })
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

    this.appendCombinedLog({
      workerId: win.workerId || 'SYS',
      windowId: win.id,
      windowNumber: win.windowNumber,
      windowRange: `${win.startFormatted}–${win.endFormatted}`,
      level: 'STOPPED',
      step: 'skip window',
      message: `Skipped Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted})`,
    })

    if (
      prevStatus === 'SETUP' ||
      prevStatus === 'RUNNING' ||
      prevStatus === 'VALIDATING' ||
      prevStatus === 'RETRYING' ||
      prevStatus === '403_WAIT'
    ) {
      const jobScanScope = `parallel-${this.scanId}-${win.id}`
      const leased = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)
      for (const slot of leased) {
        if (slot.leasedWindowId === windowId) {
          slot.controller.requestStop({ scanId: jobScanScope })
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

    this.appendCombinedLog({
      workerId: 'SYS',
      windowId: win.id,
      windowNumber: win.windowNumber,
      windowRange: `${win.startFormatted}–${win.endFormatted}`,
      level: 'RETRY',
      step: 'manual retry window',
      message: `Re-queued Window #${win.windowNumber} (${win.startFormatted}–${win.endFormatted}) for retry`,
    })

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

    if (count > 0) {
      this.appendCombinedLog({
        workerId: 'SYS',
        level: 'RETRY',
        step: 'retry failed windows',
        message: `Re-queued ${count} failed/stopped window(s) for ${this.scanName}`,
      })
    }

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
    this.refreshScanMetadataFromStore()
    const slotPool = globalProfileSlotPool.getSummary(this.maxTotalPoolSlots)
    const leasedByThisScan = globalProfileSlotPool.getLeasedSlotsForScan(this.scanId)

    // Sync live in-flight window telemetry from slots currently leased by THIS scan
    for (const slot of leasedByThisScan) {
      if (!slot.leasedWindowId) continue
      const win = this.windows.find((w) => w.id === slot.leasedWindowId)
      if (win) {
        const meta = slot.controller.getActiveRunMeta()
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
    const totalCards = Math.max(this.concurrency, slotPool.totalSlots || DEFAULT_STUDIO_CONCURRENCY)

    for (let i = 1; i <= totalCards; i++) {
      const slot = globalProfileSlotPool.getOrCreateSlot(i)
      const isLeasedByThisScan = slot.leasedByScanId === this.scanId
      const isLeasedByOtherScan =
        slot.leasedByScanId !== null && slot.leasedByScanId !== this.scanId
      const activeWin =
        isLeasedByThisScan && slot.leasedWindowId
          ? this.windows.find((w) => w.id === slot.leasedWindowId) || null
          : null

      if (isLeasedByThisScan) {
        const snap = await slot.controller.getSnapshot(
          captureThumbnails && Boolean(activeWin),
          {
            quality: 38,
            minIntervalMs: 3000,
            maxLogs: 200,
          },
        )
        const meta = slot.controller.getActiveRunMeta()
        workerCards.push({
          workerId: slot.workerId,
          workerIndex: i,
          profileDirName: slot.profileDirName,
          active: true,
          leasedByScanId: this.scanId,
          leasedByScanLabel: this.scanName,
          leasedByOtherScan: false,
          status: activeWin ? activeWin.status : 'SETUP',
          windowId: activeWin?.id ?? slot.leasedWindowId,
          windowNumber: activeWin?.windowNumber ?? slot.leasedWindowNumber,
          windowRange: activeWin
            ? `${activeWin.startFormatted}–${activeWin.endFormatted}`
            : slot.leasedWindowRange,
          runLabel: activeWin?.runLabel ?? null,
          modelName: activeWin?.modelName || meta.modelName || 'Gemini 3.8 Flash',
          stage: activeWin ? meta.currentStep : snap.currentStep || 'running',
          tokens: activeWin ? meta.tokenCount : snap.tokenCount,
          elapsedSec: activeWin?.elapsedSec ?? snap.elapsedSec,
          attempt: activeWin?.attempt ?? meta.attempt,
          maxAttempts: activeWin?.maxAttempts ?? meta.maxAttempts,
          permRetry: activeWin?.permRetry ?? meta.permRetry,
          summaryText: activeWin?.summaryText ?? null,
          screenshotBase64: snap.screenshotBase64,
          screenshotAt: snap.screenshotAt,
          logs: slot.controller.getLogs(200),
        })
      } else if (isLeasedByOtherScan) {
        // Slot is currently leased by a DIFFERENT scan: never leak the other scan's window controls or screenshot as ours
        workerCards.push({
          workerId: slot.workerId,
          workerIndex: i,
          profileDirName: slot.profileDirName,
          active: false,
          leasedByScanId: slot.leasedByScanId,
          leasedByScanLabel: slot.leasedByScanLabel,
          leasedByOtherScan: true,
          status: 'IDLE',
          windowId: null,
          windowNumber: null,
          windowRange: null,
          runLabel: null,
          modelName: 'Gemini 3.8 Flash',
          stage: `In use by ${slot.leasedByScanLabel || slot.leasedByScanId}`,
          tokens: null,
          elapsedSec: 0,
          attempt: 0,
          maxAttempts: 5,
          permRetry: 0,
          summaryText: `Busy (${slot.leasedByScanLabel || slot.leasedByScanId})`,
          screenshotBase64: null,
          screenshotAt: null,
          logs: [],
        })
      } else {
        workerCards.push({
          workerId: slot.workerId,
          workerIndex: i,
          profileDirName: slot.profileDirName,
          active: false,
          leasedByScanId: null,
          leasedByScanLabel: null,
          leasedByOtherScan: false,
          status: this.waitingForWorkerSlots ? 'WAITING_FOR_WORKER' : 'IDLE',
          windowId: null,
          windowNumber: null,
          windowRange: null,
          runLabel: null,
          modelName: 'Gemini 3.8 Flash',
          stage: this.waitingForWorkerSlots ? 'WAITING FOR WORKER' : 'idle',
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

    const activeWorkersCount = leasedByThisScan.length
    const doneCount = this.windows.filter((w) => w.status === 'DONE').length
    const queuedCount = this.windows.filter(
      (w) => w.status === 'QUEUED' || w.status === 'WAITING_FOR_WORKER',
    ).length
    const failedCount = this.windows.filter(
      (w) => w.status === 'FAILED' || w.status === 'STOPPED',
    ).length
    const needsAttentionCount = this.windows.filter((w) => w.status === 'NEEDS_ATTENTION').length
    const elapsedSec =
      this.startedAt && this.active
        ? Math.round((Date.now() - this.startedAt) / 1000)
        : this.startedAt && this.finishedAt
          ? Math.max(0, Math.round((this.finishedAt - this.startedAt) / 1000))
          : this.windows.reduce((acc, w) => Math.max(acc, w.elapsedSec || 0), 0)

    return {
      active: this.active,
      paused: this.paused,
      waitingForWorkerSlots: this.waitingForWorkerSlots,
      scanId: this.scanId,
      scanName: this.scanName,
      username: this.username,
      minuteInput: this.minuteInput,
      concurrency: this.concurrency,
      measuredTokenRate: this.measuredTokenRate,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
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
      slotPool,
      workers: workerCards,
      windows: this.windows,
      mergedReport: this.getMergedReport(),
      combinedLogs: this.combinedLogs,
      totalLogLinesOnDisk: this.totalLogLinesOnDisk,
      resourceSnapshots: this.resourceSnapshots,
    }
  }
}

function getManagersMap(): Map<string, StudioParallelManager> {
  if (!globalForParallelStudio.__cmtStudioParallelManagers) {
    globalForParallelStudio.__cmtStudioParallelManagers = new Map<string, StudioParallelManager>()
  }
  const map = globalForParallelStudio.__cmtStudioParallelManagers

  if (!globalForParallelStudio.__cmtStudioParallelRestored) {
    globalForParallelStudio.__cmtStudioParallelRestored = true
    try {
      const scansRoot = path.join(DATA_DIR, 'scans')
      if (fs.existsSync(scansRoot)) {
        const entries = fs.readdirSync(scansRoot)
        for (const dirName of entries) {
          const stateFile = path.join(scansRoot, dirName, 'parallel-state.json')
          const legacyWinFile = path.join(scansRoot, dirName, 'parallel-windows.json')
          if (fs.existsSync(stateFile) || fs.existsSync(legacyWinFile)) {
            if (!map.has(dirName)) {
              map.set(dirName, new StudioParallelManager(dirName))
            }
          }
        }
      }
      // Also check legacy global file once for migration
      if (fs.existsSync(LEGACY_PARALLEL_STATE_FILE)) {
        try {
          const legacy = JSON.parse(fs.readFileSync(LEGACY_PARALLEL_STATE_FILE, 'utf8'))
          if (legacy && typeof legacy.scanId === 'string' && legacy.scanId) {
            if (!map.has(legacy.scanId)) {
              const mgr = new StudioParallelManager(legacy.scanId)
              map.set(legacy.scanId, mgr)
            }
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore startup scan dir walk error */
    }
  }

  return map
}

/**
 * Get the isolated StudioParallelManager for a specific scanId.
 */
export function getStudioParallelManager(scanId?: string | null): StudioParallelManager {
  const key = (scanId || '').trim() || 'default'
  const map = getManagersMap()
  let mgr = map.get(key)
  if (!mgr) {
    mgr = new StudioParallelManager(key)
    map.set(key, mgr)
  } else {
    Object.setPrototypeOf(mgr, StudioParallelManager.prototype)
  }
  return mgr
}

export function stopAndDeleteStudioParallelManager(scanId: string): void {
  const key = (scanId || '').trim()
  if (!key) return
  const map = getManagersMap()
  const mgr = map.get(key)
  if (mgr) {
    mgr.stopAll()
    map.delete(key)
  }
  globalProfileSlotPool.releaseAllSlotsForScan(key)
  try {
    fs.rmSync(path.join(DATA_DIR, 'scans', key), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

export const studioParallelManager = getStudioParallelManager('default')
