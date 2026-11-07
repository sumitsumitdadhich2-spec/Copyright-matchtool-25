import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths'
import { extractWindowClip, probeDuration, verifyWindowClipFile } from './ffmpeg'
import type { CancelToken } from './ffmpeg-pool'

const SCAN_FPS = 24

export interface WindowClipInput {
  windowNumber: number
  startSec: number
  endSec: number
}

export interface WindowClipResult {
  clipPath: string
  clipStartFrame: number
  clipStartSec: number
  frameCount: number
  durationSec: number
  cached: boolean
}

export interface WindowClipSidecar {
  version: 1
  windowNumber: number
  startFrame: number
  endFrame: number
  frameCount: number
  clipStartSec: number
  durationSec: number
  movieSize: number
  movieMtimeMs: number
  size: number
  mtime: number
  createdAt: number
  ytUrl?: string
  ytVideoId?: string
  ytUploadedAt?: number
  ytDeleted?: boolean
}

const globalForWindowClips = globalThis as unknown as {
  __cmtWindowClipInflight?: Map<string, Promise<WindowClipResult>>
  __cmtMovieDurationCache?: Map<
    string,
    { size: number; mtimeMs: number; promise: Promise<number> }
  >
}

function getInflightMap(): Map<string, Promise<WindowClipResult>> {
  if (!globalForWindowClips.__cmtWindowClipInflight) {
    globalForWindowClips.__cmtWindowClipInflight = new Map()
  }
  return globalForWindowClips.__cmtWindowClipInflight
}

function getMovieDurationCache(): Map<
  string,
  { size: number; mtimeMs: number; promise: Promise<number> }
> {
  if (!globalForWindowClips.__cmtMovieDurationCache) {
    globalForWindowClips.__cmtMovieDurationCache = new Map()
  }
  return globalForWindowClips.__cmtMovieDurationCache
}

/**
 * Persistent clips directory under <DATA_DIR>/media/<scanId>/clips.
 * Never writes under WORK_DIR (/dev/shm/cmt).
 */
export function getScanWindowClipsDir(scanId: string): string {
  return path.join(DATA_DIR, 'media', scanId, 'clips')
}

export function getWindowClipSidecarPath(clipPath: string): string {
  return clipPath.replace(/\.mp4$/i, '.json')
}

/**
 * Delete stale *.partial files in <DATA_DIR>/media/<scanId>/clips at scan start.
 */
export function cleanStaleWindowClipPartials(scanId: string): number {
  const clipsDir = getScanWindowClipsDir(scanId)
  if (!fs.existsSync(clipsDir)) return 0
  let removed = 0
  try {
    for (const name of fs.readdirSync(clipsDir)) {
      if (name.endsWith('.partial') || name.endsWith('.tmp')) {
        try {
          fs.rmSync(path.join(clipsDir, name), { force: true })
          removed += 1
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return removed
}

async function getProbedMovieDurationCached(
  moviePath: string,
  size: number,
  mtimeMs: number,
): Promise<number> {
  const cache = getMovieDurationCache()
  const cached = cache.get(moviePath)
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return cached.promise
  }
  const promise = probeDuration(moviePath)
  promise.catch(() => {
    if (cache.get(moviePath)?.promise === promise) {
      cache.delete(moviePath)
    }
  })
  cache.set(moviePath, { size, mtimeMs, promise })
  return promise
}

function safeRemoveClipFiles(clipPath: string, sidecarPath: string) {
  for (const p of [clipPath, sidecarPath, `${clipPath}.json`, `${clipPath}.partial`, `${sidecarPath}.tmp`]) {
    try {
      fs.rmSync(p, { force: true })
    } catch {
      /* ignore */
    }
  }
}

function readValidSidecar(
  sidecarPath: string,
  altSidecarPath: string,
  expectedStartFrame: number,
  expectedFrameCount: number,
  movieSize: number,
  movieMtimeMs: number,
): boolean {
  const pathToRead = fs.existsSync(sidecarPath)
    ? sidecarPath
    : fs.existsSync(altSidecarPath)
      ? altSidecarPath
      : null
  if (!pathToRead) return false
  try {
    const raw = JSON.parse(fs.readFileSync(pathToRead, 'utf8')) as Partial<WindowClipSidecar>
    if (raw.version !== 1) return false
    if (raw.startFrame !== expectedStartFrame) return false
    if (raw.frameCount !== expectedFrameCount) return false
    const recordedSize = raw.movieSize ?? raw.size
    const recordedMtime = raw.movieMtimeMs ?? raw.mtime
    if (recordedSize !== movieSize) return false
    if (typeof recordedMtime !== 'number' || Math.round(recordedMtime) !== movieMtimeMs) return false
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the frame-exact window clip exists on persistent disk under:
 *   <DATA_DIR>/media/<scanId>/clips/win-<windowNumber>-f<startFrame>-<endFrame>.mp4
 * with sidecar .json written ONLY AFTER the successful atomic rename.
 *
 * Reuses a cached clip ONLY if:
 *   1. clip + sidecar exist
 *   2. sidecar matches movie.mp4 size + mtime and window startFrame + frameCount (version=1)
 *   3. ffprobe video frame count matches frameCount (and 24 fps)
 * Otherwise deletes and re-extracts.
 *
 * Memoizes in-flight promises per clipPath so concurrent callers share ONE extraction.
 */
export async function ensureWindowClip(
  scanId: string,
  window: WindowClipInput,
  opts?: {
    token?: CancelToken
    moviePath?: string
  },
): Promise<WindowClipResult> {
  const sourceMoviePath = opts?.moviePath || path.join(DATA_DIR, 'media', scanId, 'movie.mp4')
  if (!fs.existsSync(sourceMoviePath)) {
    throw new Error(`Original movie.mp4 not found at ${sourceMoviePath}`)
  }
  const movieStat = fs.statSync(sourceMoviePath)
  if (movieStat.size <= 0) {
    throw new Error(`Original movie.mp4 is empty (0 bytes) at ${sourceMoviePath}`)
  }
  const movieSize = movieStat.size
  const movieMtimeMs = Math.round(movieStat.mtimeMs)

  const movieDur = await getProbedMovieDurationCached(sourceMoviePath, movieSize, movieMtimeMs)
  const movieLastFrame = Math.max(1, Math.round(movieDur * SCAN_FPS))
  const startFrame = Math.max(0, Math.round(window.startSec * SCAN_FPS))
  const clipStartSec = startFrame / SCAN_FPS
  const endFrame = Math.min(movieLastFrame, Math.round(window.endSec * SCAN_FPS))
  const frameCount = endFrame - startFrame
  if (frameCount <= 0) {
    throw new Error(
      `Invalid window clip frame range for Window #${window.windowNumber} (${window.startSec}s..${window.endSec}s): startFrame=${startFrame}, endFrame=${endFrame}, movieLastFrame=${movieLastFrame}`,
    )
  }
  const durationSec = frameCount / SCAN_FPS

  const clipsDir = getScanWindowClipsDir(scanId)
  fs.mkdirSync(clipsDir, { recursive: true })

  const clipPath = path.join(
    clipsDir,
    `win-${window.windowNumber}-f${startFrame}-${endFrame}.mp4`,
  )
  const sidecarPath = getWindowClipSidecarPath(clipPath)
  const altSidecarPath = `${clipPath}.json`

  const inflight = getInflightMap()
  const existingPromise = inflight.get(clipPath)
  if (existingPromise) {
    return existingPromise
  }

  const jobPromise = (async (): Promise<WindowClipResult> => {
    // Remove any leftover .partial for this clip before checking cache
    if (fs.existsSync(`${clipPath}.partial`)) {
      try {
        fs.rmSync(`${clipPath}.partial`, { force: true })
      } catch {
        /* ignore */
      }
    }

    // Check cache validity: clip + sidecar exist, sidecar matches movie size/mtime & frames, ffprobe frameCount matches
    if (fs.existsSync(clipPath)) {
      let cacheValid = false
      try {
        const clipStat = fs.statSync(clipPath)
        if (
          clipStat.size > 0 &&
          readValidSidecar(
            sidecarPath,
            altSidecarPath,
            startFrame,
            frameCount,
            movieSize,
            movieMtimeMs,
          )
        ) {
          await verifyWindowClipFile(clipPath, frameCount)
          cacheValid = true
        }
      } catch {
        cacheValid = false
      }

      if (cacheValid) {
        return {
          clipPath,
          clipStartFrame: startFrame,
          clipStartSec,
          frameCount,
          durationSec,
          cached: true,
        }
      }

      // Preserve any existing valid YouTube upload metadata before re-extracting
    }

    let preservedYt: Partial<Pick<WindowClipSidecar, 'ytUrl' | 'ytVideoId' | 'ytUploadedAt' | 'ytDeleted'>> = {}
    for (const scCandidate of [sidecarPath, altSidecarPath]) {
      try {
        if (fs.existsSync(scCandidate)) {
          const prevRaw = JSON.parse(fs.readFileSync(scCandidate, 'utf8')) as Partial<WindowClipSidecar>
          if (prevRaw && prevRaw.ytUrl && !prevRaw.ytDeleted) {
            preservedYt = {
              ytUrl: prevRaw.ytUrl,
              ytVideoId: prevRaw.ytVideoId,
              ytUploadedAt: prevRaw.ytUploadedAt,
              ytDeleted: false,
            }
            break
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (fs.existsSync(clipPath) || fs.existsSync(sidecarPath) || fs.existsSync(altSidecarPath)) {
      safeRemoveClipFiles(clipPath, sidecarPath)
    }

    const extracted = await extractWindowClip(
      sourceMoviePath,
      window.startSec,
      window.endSec,
      clipPath,
      opts?.token,
    )

    // Write sidecar .json ONLY AFTER extractWindowClip's successful atomic rename
    const sidecarData: WindowClipSidecar = {
      version: 1,
      windowNumber: window.windowNumber,
      startFrame: extracted.clipStartFrame,
      endFrame: extracted.clipStartFrame + extracted.frameCount,
      frameCount: extracted.frameCount,
      clipStartSec: extracted.clipStartSec,
      durationSec: extracted.durationSec,
      movieSize,
      movieMtimeMs,
      size: movieSize,
      mtime: movieMtimeMs,
      createdAt: Date.now(),
      ...preservedYt,
    }
    const tmpSidecar = `${sidecarPath}.tmp`
    fs.writeFileSync(tmpSidecar, JSON.stringify(sidecarData, null, 2), 'utf8')
    fs.renameSync(tmpSidecar, sidecarPath)

    return {
      clipPath,
      clipStartFrame: extracted.clipStartFrame,
      clipStartSec: extracted.clipStartSec,
      frameCount: extracted.frameCount,
      durationSec: extracted.durationSec,
      cached: false,
    }
  })()

  inflight.set(clipPath, jobPromise)
  try {
    return await jobPromise
  } finally {
    inflight.delete(clipPath)
  }
}

export function resolveClipSidecarPath(
  clipPathOrScanId: string,
  windowNumber?: number,
): string | null {
  if (typeof windowNumber === 'number') {
    const clipsDir = getScanWindowClipsDir(clipPathOrScanId)
    if (!fs.existsSync(clipsDir)) return null
    try {
      const files = fs.readdirSync(clipsDir)
      const prefix = `win-${windowNumber}-`
      const match = files.find((f) => f.startsWith(prefix) && f.endsWith('.json'))
      if (match) return path.join(clipsDir, match)
      const ytDirect = path.join(clipsDir, `win-${windowNumber}-yt.json`)
      if (fs.existsSync(ytDirect)) return ytDirect
    } catch {
      return null
    }
    return null
  }
  return getWindowClipSidecarPath(clipPathOrScanId)
}

export function readClipYtSidecar(
  clipPathOrScanId: string,
  windowNumber?: number,
): {
  scanId?: string
  ytUrl?: string
  ytVideoId?: string
  ytUploadedAt?: number
  ytDeleted?: boolean
} | null {
  const sidecarPath = resolveClipSidecarPath(clipPathOrScanId, windowNumber)
  if (!sidecarPath || !fs.existsSync(sidecarPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Partial<WindowClipSidecar> & {
      scanId?: string
    }
    if (raw && raw.ytUrl && !raw.ytDeleted) {
      // If called with a scanId, verify the sidecar wasn't written with a different scanId/scanPrefix
      if (typeof windowNumber === 'number' && raw.scanId && clipPathOrScanId) {
        const expectedPrefix = clipPathOrScanId.slice(0, 8).toLowerCase()
        const rawPrefix = raw.scanId.slice(0, 8).toLowerCase()
        if (expectedPrefix && rawPrefix && expectedPrefix !== rawPrefix) {
          return null
        }
      }
      return {
        scanId: raw.scanId,
        ytUrl: raw.ytUrl,
        ytVideoId: raw.ytVideoId,
        ytUploadedAt: raw.ytUploadedAt,
        ytDeleted: Boolean(raw.ytDeleted),
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function saveClipYtSidecar(
  clipPathOrScanId: string,
  windowNumberOrYtUrlOrData:
    | number
    | string
    | {
        scanId?: string
        windowNumber?: number
        ytUrl: string
        ytVideoId?: string
        ytUploadedAt?: number
        ytDeleted?: boolean
      },
  dataOrVideoId?: { ytUrl: string; ytVideoId?: string; ytUploadedAt?: number } | string,
): boolean {
  let targetSidecarPath: string | null = null
  let ytUrl = ''
  let ytVideoId = ''
  let ytUploadedAt = Date.now()
  let scanIdMeta: string | undefined
  let clipSize = 0
  let clipMtime = 0

  if (typeof windowNumberOrYtUrlOrData === 'number') {
    const scanId = clipPathOrScanId
    scanIdMeta = scanId
    const winNum = windowNumberOrYtUrlOrData
    const data = typeof dataOrVideoId === 'object' ? dataOrVideoId : { ytUrl: String(dataOrVideoId || '') }
    ytUrl = data.ytUrl
    ytVideoId = data.ytVideoId || ''
    ytUploadedAt = data.ytUploadedAt || Date.now()

    const clipsDir = getScanWindowClipsDir(scanId)
    try {
      fs.mkdirSync(clipsDir, { recursive: true })
    } catch {
      /* ignore */
    }
    const existingSidecar = resolveClipSidecarPath(scanId, winNum)
    targetSidecarPath = existingSidecar || path.join(clipsDir, `win-${winNum}-yt.json`)
  } else if (typeof windowNumberOrYtUrlOrData === 'object' && windowNumberOrYtUrlOrData !== null) {
    targetSidecarPath = getWindowClipSidecarPath(clipPathOrScanId)
    ytUrl = windowNumberOrYtUrlOrData.ytUrl
    ytVideoId = windowNumberOrYtUrlOrData.ytVideoId || ''
    ytUploadedAt = windowNumberOrYtUrlOrData.ytUploadedAt || Date.now()
    scanIdMeta = windowNumberOrYtUrlOrData.scanId
    if (fs.existsSync(clipPathOrScanId)) {
      try {
        const st = fs.statSync(clipPathOrScanId)
        clipSize = st.size
        clipMtime = Math.round(st.mtimeMs)
      } catch {
        /* ignore */
      }
    }
  } else {
    targetSidecarPath = getWindowClipSidecarPath(clipPathOrScanId)
    ytUrl = windowNumberOrYtUrlOrData
    ytVideoId = typeof dataOrVideoId === 'string' ? dataOrVideoId : ''
    if (fs.existsSync(clipPathOrScanId)) {
      try {
        const st = fs.statSync(clipPathOrScanId)
        clipSize = st.size
        clipMtime = Math.round(st.mtimeMs)
      } catch {
        /* ignore */
      }
    }
  }

  if (!targetSidecarPath) return false
  try {
    let existing: Record<string, unknown> = {}
    if (fs.existsSync(targetSidecarPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(targetSidecarPath, 'utf8')) as Record<string, unknown>
      } catch {
        existing = {}
      }
    }
    const updated = {
      ...existing,
      ...(scanIdMeta ? { scanId: scanIdMeta } : {}),
      ytUrl,
      ytVideoId,
      ytUploadedAt,
      ytDeleted: false,
      ...(clipSize > 0 ? { size: clipSize, mtime: clipMtime } : {}),
    }
    const tmp = `${targetSidecarPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8')
    fs.renameSync(tmp, targetSidecarPath)
    return true
  } catch {
    return false
  }
}

export function markClipYtDeleted(clipPathOrScanId: string, windowNumber?: number): void {
  const sidecarPath = resolveClipSidecarPath(clipPathOrScanId, windowNumber)
  if (!sidecarPath || !fs.existsSync(sidecarPath)) return
  try {
    const existing = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as Record<string, unknown>
    existing.ytDeleted = true
    const tmpPath = `${sidecarPath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf8')
    fs.renameSync(tmpPath, sidecarPath)
  } catch {
    /* ignore */
  }
}

export function markAllChannelClipsYtDeleted(onlyScanId?: string): number {
  let count = 0
  try {
    if (!fs.existsSync(MEDIA_DIR)) return 0
    const scanDirs = onlyScanId
      ? [onlyScanId]
      : fs.readdirSync(MEDIA_DIR)
    for (const sDir of scanDirs) {
      const clipsDir = path.join(MEDIA_DIR, sDir, 'clips')
      if (!fs.existsSync(clipsDir)) continue
      const files = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.json'))
      for (const f of files) {
        const fullPath = path.join(clipsDir, f)
        try {
          const existing = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as Record<string, unknown>
          if (existing && existing.ytUrl && !existing.ytDeleted) {
            existing.ytDeleted = true
            const tmpPath = `${fullPath}.tmp`
            fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf8')
            fs.renameSync(tmpPath, fullPath)
            count++
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return count
}
