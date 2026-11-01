import { readJSONRecord, writeJSONRecord } from './json-record'

export const STUDIO_MODEL_OPTIONS = [
  'Argon',
  'Gemini 3.8 Flash',
  'Gemini 3.6 Flash',
] as const

export type StudioModelOption = (typeof STUDIO_MODEL_OPTIONS)[number]

/**
 * Up to 10 parallel windows can run simultaneously on the same configured model.
 * Model switches only when quota/daily-limit is reached.
 */
export const MAX_CONCURRENT_MODEL_WINDOWS = 10
export const MAX_PARALLEL_CONCURRENCY = 10

export const DEFAULT_STUDIO_MODEL_NAME: StudioModelOption = 'Argon'

export const ARGON_MAX_OUTPUT_TOKENS = 1_000_000
export const FLASH_DEFAULT_MAX_OUTPUT_TOKENS = 65_536

export type StudioThinkingLevel = 'high' | 'medium' | 'low'

export const DEFAULT_STUDIO_THINKING_LEVEL: StudioThinkingLevel = 'high'

export const QUOTA_RESET_TZ = 'America/Los_Angeles'

const MODEL_QUOTA_RECORD_KEY = 'studio-model-quota.json'

export interface StudioModelQuotaState {
  /** Map of canonical model name -> Unix timestamp (ms) when quota resets */
  exhausted: Record<string, number>
  updatedAt: number
}

export function normalizeStudioThinkingLevel(val: unknown): StudioThinkingLevel {
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase()
    if (clean === 'high' || clean === 'medium' || clean === 'low') {
      return clean
    }
  }
  return DEFAULT_STUDIO_THINKING_LEVEL
}

export function thinkingLevelToDisplayLabel(level?: StudioThinkingLevel | string | null): 'High' | 'Medium' | 'Low' {
  const norm = normalizeStudioThinkingLevel(level)
  if (norm === 'medium') return 'Medium'
  if (norm === 'low') return 'Low'
  return 'High'
}

/**
 * Strictly canonicalize to the 3 allowed models ONLY:
 * - 'Argon'
 * - 'Gemini 3.8 Flash'
 * - 'Gemini 3.6 Flash'
 * (3.7 is removed everywhere; any 3.7 or unknown model maps to 'Gemini 3.8 Flash' or 'Argon').
 */
export function canonicalizeStudioModelName(raw?: string | null): StudioModelOption {
  const trimmed = (raw || '').trim()
  if (!trimmed) return DEFAULT_STUDIO_MODEL_NAME
  if (/^argon$/i.test(trimmed) || /\bargon\b/i.test(trimmed)) return 'Argon'
  if (/3\.8/.test(trimmed)) return 'Gemini 3.8 Flash'
  if (/3\.6/.test(trimmed)) return 'Gemini 3.6 Flash'
  if (/3\.7/.test(trimmed)) return 'Gemini 3.8 Flash'
  return 'Gemini 3.8 Flash'
}

/**
 * Whenever Argon is used, Output length (maxOutputTokens) MUST be 1,000,000 (1000000).
 * For Gemini 3.8 Flash / Gemini 3.6 Flash, use 65,536 (or user setting <= 65,536).
 */
export function resolveEffectiveMaxOutputTokensForModel(
  modelName?: string | null,
  configuredMaxOutputTokens?: number | null,
): number {
  const canon = canonicalizeStudioModelName(modelName)
  if (canon === 'Argon') {
    return ARGON_MAX_OUTPUT_TOKENS
  }
  const num = Number(configuredMaxOutputTokens)
  if (Number.isFinite(num) && num >= 1024 && num <= FLASH_DEFAULT_MAX_OUTPUT_TOKENS) {
    return Math.floor(num)
  }
  return FLASH_DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * Build the ordered fallback chain starting from the user's chosen model
 * across the 3 allowed models: Argon, Gemini 3.8 Flash, Gemini 3.6 Flash.
 */
export function buildStudioModelChain(chosenModel?: string | null): StudioModelOption[] {
  const canonical = canonicalizeStudioModelName(chosenModel)
  const idx = STUDIO_MODEL_OPTIONS.findIndex(
    (opt) => opt.toLowerCase() === canonical.toLowerCase(),
  )
  if (idx >= 0) {
    return [...STUDIO_MODEL_OPTIONS.slice(idx), ...STUDIO_MODEL_OPTIONS.slice(0, idx)]
  }
  return [...STUDIO_MODEL_OPTIONS]
}

/**
 * Build a complete fallback cycle across all 3 allowed models
 * ('Argon', 'Gemini 3.8 Flash', 'Gemini 3.6 Flash') starting from `chosenModel`.
 */
export function buildStudioFallbackCycle(chosenModel?: string | null): StudioModelOption[] {
  const primary = buildStudioModelChain(chosenModel)
  const seen = new Set(primary.map((m) => canonicalizeStudioModelName(m).toLowerCase()))
  const full: StudioModelOption[] = [...primary]
  for (const opt of STUDIO_MODEL_OPTIONS) {
    const key = opt.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      full.push(opt)
    }
  }
  return full
}

export function getActiveLeasedModelsByOtherHolders(): Map<StudioModelOption, number> {
  return new Map<StudioModelOption, number>()
}

export function updateExclusiveStudioModelLease(
  _holderKey: string,
  modelName: string,
): StudioModelOption {
  return canonicalizeStudioModelName(modelName)
}

export function releaseExclusiveStudioModel(_holderKey?: string): void {
  // No-op: multiple windows share the same model
}

export function orderChainByUnleasedFirst(
  _holderKey: string | undefined,
  chain: readonly string[],
): StudioModelOption[] {
  const normalizedChain: StudioModelOption[] = []
  const seen = new Set<string>()
  for (const raw of [...chain, ...STUDIO_MODEL_OPTIONS]) {
    const canon = canonicalizeStudioModelName(raw)
    if (!seen.has(canon.toLowerCase())) {
      seen.add(canon.toLowerCase())
      normalizedChain.push(canon)
    }
  }
  return normalizedChain
}

export function orderFallbacksKeepingTargetFirst(
  _holderKey: string | undefined,
  targetModelName: string,
  chain: readonly string[],
): StudioModelOption[] {
  const targetCanon = canonicalizeStudioModelName(targetModelName)
  const rest = orderChainByUnleasedFirst(undefined, chain).filter(
    (m) => m.toLowerCase() !== targetCanon.toLowerCase(),
  )
  return [targetCanon, ...rest]
}

function getTzWallParts(
  utcMs: number,
  timeZone: string,
): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const map: Record<string, number> = {}
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = Number(p.value)
    }
  }
  return {
    year: map.year || 1970,
    month: map.month || 1,
    day: map.day || 1,
    hour: map.hour === 24 ? 0 : map.hour || 0,
    minute: map.minute || 0,
    second: map.second || 0,
  }
}

function getTzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = getTzWallParts(utcMs, timeZone)
  const wallAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const truncatedUtcMs = Math.floor(utcMs / 1000) * 1000
  return wallAsUtcMs - truncatedUtcMs
}

/**
 * Compute the Unix timestamp (ms) of the next 00:00:00 midnight in `QUOTA_RESET_TZ`
 * ('America/Los_Angeles'), accurately accounting for PST/PDT daylight saving transitions.
 */
export function nextPacificMidnight(nowMs: number = Date.now()): number {
  const nowParts = getTzWallParts(nowMs, QUOTA_RESET_TZ)
  // Next calendar date in QUOTA_RESET_TZ
  const nextDayUtcDate = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1))
  const nextYear = nextDayUtcDate.getUTCFullYear()
  const nextMonth = nextDayUtcDate.getUTCMonth() + 1
  const nextDay = nextDayUtcDate.getUTCDate()

  // Target wall clock is nextYear-nextMonth-nextDay 00:00:00 in QUOTA_RESET_TZ
  const targetWallAsUtcMs = Date.UTC(nextYear, nextMonth - 1, nextDay, 0, 0, 0, 0)

  // Initial guess assuming UTC-8 (PST), then refine twice with exact timezone offset at that instant
  const approxUtcMs = targetWallAsUtcMs + 8 * 3600_000
  const offset1 = getTzOffsetMs(approxUtcMs, QUOTA_RESET_TZ)
  const guess1 = targetWallAsUtcMs - offset1
  const offset2 = getTzOffsetMs(guess1, QUOTA_RESET_TZ)
  return targetWallAsUtcMs - offset2
}

export async function loadStudioModelQuotaState(
  nowMs: number = Date.now(),
): Promise<StudioModelQuotaState> {
  const saved = await readJSONRecord<StudioModelQuotaState>(MODEL_QUOTA_RECORD_KEY)
  const rawExhausted =
    saved && saved.exhausted && typeof saved.exhausted === 'object' ? saved.exhausted : {}

  const cleaned: Record<string, number> = {}
  let changed = false

  for (const [modelKey, untilTs] of Object.entries(rawExhausted)) {
    if (/3\.7/.test(modelKey)) {
      changed = true
      continue
    }
    const numTs = Number(untilTs)
    if (Number.isFinite(numTs) && numTs > nowMs) {
      cleaned[canonicalizeStudioModelName(modelKey)] = numTs
    } else {
      changed = true
    }
  }

  const state: StudioModelQuotaState = {
    exhausted: cleaned,
    updatedAt: changed ? nowMs : saved?.updatedAt || nowMs,
  }

  if (changed) {
    await writeJSONRecord(MODEL_QUOTA_RECORD_KEY, state)
  }

  return state
}

export async function markModelExhausted(
  model: string,
  nowMs: number = Date.now(),
): Promise<{ model: string; untilTimestamp: number; state: StudioModelQuotaState }> {
  const canonical = canonicalizeStudioModelName(model)
  const current = await loadStudioModelQuotaState(nowMs)
  const untilTimestamp = nextPacificMidnight(nowMs)
  const nextState: StudioModelQuotaState = {
    exhausted: {
      ...current.exhausted,
      [canonical]: untilTimestamp,
    },
    updatedAt: nowMs,
  }
  await writeJSONRecord(MODEL_QUOTA_RECORD_KEY, nextState)
  return { model: canonical, untilTimestamp, state: nextState }
}

export async function resetModelQuotaState(
  model?: string | null,
  nowMs: number = Date.now(),
): Promise<StudioModelQuotaState> {
  const current = await loadStudioModelQuotaState(nowMs)
  const nextExhausted: Record<string, number> = { ...current.exhausted }
  if (model && model.trim()) {
    const canonical = canonicalizeStudioModelName(model)
    delete nextExhausted[canonical]
    delete nextExhausted[model.trim()]
  } else {
    for (const k of Object.keys(nextExhausted)) {
      delete nextExhausted[k]
    }
  }
  const nextState: StudioModelQuotaState = {
    exhausted: nextExhausted,
    updatedAt: nowMs,
  }
  await writeJSONRecord(MODEL_QUOTA_RECORD_KEY, nextState)
  return nextState
}

/**
 * Starting from `chosenModel`, return the first model in `chain` that is not exhausted
 * (or whose `untilTimestamp <= nowMs`), prioritizing models NOT currently leased by
 * another active window when `holderKey` is provided.
 * If all models in the chain are exhausted, returns `''` (empty string).
 */
export async function getEffectiveModel(
  chosenModel?: string | null,
  chain?: string[],
  nowMs: number = Date.now(),
  _holderKey?: string,
  excludeModels?: string[],
): Promise<string> {
  const state = await loadStudioModelQuotaState(nowMs)
  const baseChain = chain && chain.length > 0 ? chain : buildStudioFallbackCycle(chosenModel)
  const startCanonical = canonicalizeStudioModelName(chosenModel || baseChain[0])
  const startIdx = baseChain.findIndex(
    (m) => canonicalizeStudioModelName(m).toLowerCase() === startCanonical.toLowerCase(),
  )
  const rotatedChain =
    startIdx >= 0
      ? [...baseChain.slice(startIdx), ...baseChain.slice(0, startIdx)]
      : [...baseChain]

  const orderedCandidates = rotatedChain.map((c) => canonicalizeStudioModelName(c))

  const excludedSet = new Set(
    (excludeModels || []).map((m) => canonicalizeStudioModelName(m).toLowerCase()),
  )

  for (const candidate of orderedCandidates) {
    const canon = canonicalizeStudioModelName(candidate)
    if (excludedSet.has(canon.toLowerCase())) continue
    const untilTs = state.exhausted[canon]
    if (!untilTs || untilTs <= nowMs) {
      return canon
    }
  }

  if (excludedSet.size > 0) {
    for (const candidate of orderedCandidates) {
      const canon = canonicalizeStudioModelName(candidate)
      const untilTs = state.exhausted[canon]
      if (!untilTs || untilTs <= nowMs) {
        return canon
      }
    }
  }

  return ''
}
