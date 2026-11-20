import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCompletedMinuteSuggestions,
  isSameShortMovieAndTrim,
  resolveReusableMinuteFinderData,
  shouldResetWindowForRetry,
} from './minute-finder-reuse'
import type { Scan } from './types'

function makeScan(overrides: Partial<Scan>): Scan {
  return {
    id: 'scan-1',
    createdAt: Date.now(),
    status: 'ready',
    shortName: 'short.mp4',
    movieName: 'movie.mp4',
    shortSize: 5_000_000,
    movieSize: 1_500_000_000,
    shortDuration: 58,
    movieDuration: 5400,
    chunkCount: 90,
    chunkingProgress: 100,
    chunks: [],
    matches: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
    modelStates: {},
    ...overrides,
  }
}

test('isSameShortMovieAndTrim matches identical short + movie + trim', () => {
  const a = makeScan({ id: 'a' })
  const b = makeScan({ id: 'b' })
  assert.equal(isSameShortMovieAndTrim(a, b, 0, 5400), true)
  // Different trim range must NOT match
  assert.equal(isSameShortMovieAndTrim(a, b, 600, 5400), false)
  // Different short size + name must NOT match
  const c = makeScan({ id: 'c', shortName: 'other.mp4', shortSize: 9_999_999 })
  assert.equal(isSameShortMovieAndTrim(a, c, 0, 5400), false)
})

test('extractCompletedMinuteSuggestions supports geminiPrescan.minuteSuggestions, appliedMinutes, and mergePipeline.approvedMinutes', () => {
  const fromSuggestions = makeScan({
    id: 's1',
    geminiPrescan: {
      status: 'done',
      windowLen: 1200,
      uploads: {},
      windows: [],
      minuteSuggestions: [
        { minute: 12, sceneCount: 2, confidences: ['match'], shortWindows: [{ start: 0, end: 25 }] },
        { minute: 45, sceneCount: 1, confidences: ['possible'], shortWindows: [{ start: 25, end: 58 }] },
      ],
    },
  })
  const res1 = extractCompletedMinuteSuggestions(fromSuggestions, 58)
  assert.deepEqual(
    res1.map((s) => s.minute),
    [12, 45],
  )

  const fromApplied = makeScan({
    id: 's2',
    geminiPrescan: {
      status: 'done',
      windowLen: 1200,
      uploads: {},
      windows: [],
      appliedMinutes: [5, 19, 5],
    },
  })
  const res2 = extractCompletedMinuteSuggestions(fromApplied, 58)
  assert.deepEqual(
    res2.map((s) => s.minute),
    [5, 19],
  )

  const fromMergePipeline = makeScan({
    id: 's3',
    mergePipeline: {
      status: 'approved',
      approvedMinutes: [33, 7],
    },
  })
  const res3 = extractCompletedMinuteSuggestions(fromMergePipeline, 58)
  assert.deepEqual(
    res3.map((s) => s.minute),
    [7, 33],
  )
})

test('resolveReusableMinuteFinderData merges completed done windows across multiple partial scans', () => {
  const current = makeScan({ id: 'curr' })
  const prevA = makeScan({
    id: 'prev-a',
    geminiPrescan: {
      status: 'error',
      windowLen: 1200,
      uploads: {},
      windows: [
        { index: 0, startOffset: 0, endOffset: 1200, status: 'done', raw: 'NOT IN THIS WINDOW', matches: 0, minutes: [] },
        { index: 1, startOffset: 1200, endOffset: 2400, status: 'done', raw: 'MATCH 21:00', matches: 1, minutes: [21] },
        { index: 2, startOffset: 2400, endOffset: 3600, status: 'failed', error: '503' },
      ],
    },
  })
  const prevB = makeScan({
    id: 'prev-b',
    geminiPrescan: {
      status: 'error',
      windowLen: 1200,
      uploads: {},
      windows: [
        { index: 2, startOffset: 2400, endOffset: 3600, status: 'done', raw: 'MATCH 42:00', matches: 1, minutes: [42] },
      ],
    },
  })

  const res = resolveReusableMinuteFinderData(current, [prevA, prevB], 0, 5400)
  assert.equal(res.completeScan, null)
  assert.equal(res.reusedDoneWindows.size, 3)
  assert.equal(res.reusedDoneWindows.get(0)?.sourceScanId, 'prev-a')
  assert.equal(res.reusedDoneWindows.get(1)?.sourceScanId, 'prev-a')
  assert.equal(res.reusedDoneWindows.get(2)?.sourceScanId, 'prev-b')
  assert.deepEqual(res.reusedDoneWindows.get(2)?.window.minutes, [42])
})

test('shouldResetWindowForRetry never resets done windows with 0 matches unless explicitly targeted', () => {
  const doneZero = { index: 0, status: 'done' as const, matches: 0 }
  const doneHits = { index: 1, status: 'done' as const, matches: 3 }
  const failedWin = { index: 2, status: 'failed' as const }
  const runningWin = { index: 3, status: 'running' as const }

  assert.equal(shouldResetWindowForRetry(doneZero, 0, null), false)
  assert.equal(shouldResetWindowForRetry(doneHits, 1, null), false)
  assert.equal(shouldResetWindowForRetry(failedWin, 2, null), true)
  assert.equal(shouldResetWindowForRetry(runningWin, 3, null), true)

  // Explicit target index overrides status
  assert.equal(shouldResetWindowForRetry(doneZero, 0, new Set([0])), true)
  assert.equal(shouldResetWindowForRetry(failedWin, 2, new Set([0])), false)
})
