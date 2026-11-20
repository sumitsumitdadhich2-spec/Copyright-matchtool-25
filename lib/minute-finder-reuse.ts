import type { GeminiPrescanWindow, MinuteSuggestion, Scan } from './types'

export interface ReusableMinuteFinderMatch {
  completeScan: Scan | null
  reusedSuggestions: MinuteSuggestion[]
  /** Merged completed ('done') windows keyed by window index across matching earlier scans. */
  reusedDoneWindows: Map<number, { sourceScanId: string; window: GeminiPrescanWindow }>
}

/**
 * Determine whether two scans refer to the same short video, same movie video,
 * and same movie trim range.
 */
export function isSameShortMovieAndTrim(
  scan: Pick<
    Scan,
    'shortSize' | 'shortName' | 'shortDuration' | 'movieSize' | 'movieName' | 'movieDuration' | 'movieTrimStart' | 'movieTrimEnd'
  >,
  cand: Pick<
    Scan,
    'shortSize' | 'shortName' | 'shortDuration' | 'movieSize' | 'movieName' | 'movieDuration' | 'movieTrimStart' | 'movieTrimEnd'
  >,
  trimStart: number,
  trimEnd: number,
): boolean {
  const sameShort = Boolean(
    (scan.shortSize && cand.shortSize && cand.shortSize === scan.shortSize) ||
      (scan.shortName &&
        cand.shortName === scan.shortName &&
        scan.shortDuration &&
        cand.shortDuration &&
        Math.abs(cand.shortDuration - scan.shortDuration) < 1.0),
  )
  const sameMovie = Boolean(
    (scan.movieSize && cand.movieSize && cand.movieSize === scan.movieSize) ||
      (scan.movieName &&
        cand.movieName === scan.movieName &&
        scan.movieDuration &&
        cand.movieDuration &&
        Math.abs(cand.movieDuration - scan.movieDuration) < 1.0),
  )
  if (!sameShort || !sameMovie) return false
  const candStart = cand.movieTrimStart ?? 0
  const candEnd = cand.movieTrimEnd ?? cand.movieDuration ?? 0
  return Math.abs(candStart - trimStart) < 1.0 && Math.abs(candEnd - trimEnd) < 1.0
}

/**
 * Extract reusable MinuteSuggestions from a completed candidate scan:
 * 1. `geminiPrescan.minuteSuggestions` (richest: includes shortWindows & confidences)
 * 2. `geminiPrescan.appliedMinutes`
 * 3. `mergePipeline.approvedMinutes`
 */
export function extractCompletedMinuteSuggestions(
  cand: Scan,
  shortDuration: number,
): MinuteSuggestion[] {
  const prescan = cand.geminiPrescan
  const hasCompletePrescan =
    Boolean(prescan?.minuteSuggestions && prescan.minuteSuggestions.length > 0) &&
    (prescan?.status === 'done' ||
      prescan?.status === 'starting_scan' ||
      (prescan?.windows &&
        prescan.windows.length > 0 &&
        prescan.windows.every((w) => w.status === 'done') &&
        (!prescan.backup ||
          prescan.backup.status === 'done' ||
          prescan.backup.status === 'skipped')))

  if (hasCompletePrescan && prescan?.minuteSuggestions && prescan.minuteSuggestions.length > 0) {
    return prescan.minuteSuggestions.map((s) => ({
      ...s,
      confidences: [...s.confidences],
      shortWindows: s.shortWindows.map((sw) => ({ ...sw })),
    }))
  }

  const fallbackMinutes =
    prescan?.appliedMinutes && prescan.appliedMinutes.length > 0
      ? prescan.appliedMinutes
      : cand.mergePipeline?.approvedMinutes && cand.mergePipeline.approvedMinutes.length > 0
        ? cand.mergePipeline.approvedMinutes
        : []

  if (fallbackMinutes.length > 0) {
    const dur = Math.max(1, shortDuration || cand.shortDuration || 60)
    return [...new Set(fallbackMinutes)]
      .sort((a, b) => a - b)
      .map((m) => ({
        minute: m,
        sceneCount: 1,
        confidences: ['match'],
        shortWindows: [{ start: 0, end: dur }],
      }))
  }

  return []
}

/**
 * Find reusable Minute Finder results across earlier scans for the exact same
 * Short + Movie + trim range.
 * - If any matching scan already completed finding minutes, returns `completeScan` + `reusedSuggestions`.
 * - Also merges all completed (`status === 'done'` with `raw`) windows across matching earlier scans
 *   so partial failures (e.g. Window #3 failed) only ever re-scan unfinished windows.
 */
export function resolveReusableMinuteFinderData(
  scan: Scan,
  earlierScans: Scan[],
  trimStart: number,
  trimEnd: number,
): ReusableMinuteFinderMatch {
  const matching = earlierScans.filter(
    (cand) => cand.id !== scan.id && isSameShortMovieAndTrim(scan, cand, trimStart, trimEnd),
  )

  let completeScan: Scan | null = null
  let reusedSuggestions: MinuteSuggestion[] = []
  const reusedDoneWindows = new Map<number, { sourceScanId: string; window: GeminiPrescanWindow }>()

  for (const cand of matching) {
    if (!completeScan) {
      const suggestions = extractCompletedMinuteSuggestions(cand, scan.shortDuration || 60)
      if (suggestions.length > 0) {
        completeScan = cand
        reusedSuggestions = suggestions
      }
    }

    const wins = cand.geminiPrescan?.windows
    if (wins && wins.length > 0) {
      for (const w of wins) {
        if (w.status === 'done' && Boolean(w.raw) && !reusedDoneWindows.has(w.index)) {
          reusedDoneWindows.set(w.index, {
            sourceScanId: cand.id,
            window: {
              ...w,
              minutes: w.minutes ? [...w.minutes] : [],
            },
          })
        }
      }
    }
  }

  return { completeScan, reusedSuggestions, reusedDoneWindows }
}

/**
 * Decide whether a Minute Finder window should be reset to 'pending' on start/retry.
 * NEVER resets an already 'done' window (even when w.matches === 0) unless explicitly
 * targeted by `targetIndices`.
 */
export function shouldResetWindowForRetry(
  w: Pick<GeminiPrescanWindow, 'index' | 'status' | 'matches'>,
  idx: number,
  targetIndices: Set<number> | null,
): boolean {
  if (targetIndices) {
    return targetIndices.has(idx) || targetIndices.has(w.index)
  }
  return w.status === 'failed' || w.status === 'running'
}
