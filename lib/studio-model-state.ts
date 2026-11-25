import { invalidateJSONRecord, readJSONRecord, writeJSONRecord } from './json-record'

/**
 * The ONLY AI Studio models the parallel scan may use, in fallback order.
 * (Gemini 4 Carbon is not available on this account, so it is never used.)
 */
export const STUDIO_MODEL_OPTIONS = [
  'Argon',
  'Gemini 3.8 Flash',
  'Hydrogen',
  'Neon',
  'Gemini 3.6 Flash',
] as const

export type StudioModelOption = (typeof STUDIO_MODEL_OPTIONS)[number]

/**
 * Max number of parallel windows that may hold the SAME model at once.
 * While 2 windows are working on Argon, no other window gets Argon; it is given the
 * next free model instead (3.8 Flash -> Hydrogen -> Neon -> 3.6 Flash). Spreading the
 * windows over several models also spreads the per-model "high demand" (503) load and
 * the per-model daily quota.
 */
export const STUDIO_MODEL_MAX_WINDOWS: Record<StudioModelOption, number> = {
  Argon: 2,
  'Gemini 3.8 Flash': 2,
  Hydrogen: 2,
  Neon: 2,
  'Gemini 3.6 Flash': 2,
}
/** Default per-model window limit for a model missing from STUDIO_MODEL_MAX_WINDOWS. */
export const DEFAULT_MAX_WINDOWS_PER_MODEL = 2
/** Total parallel worker slots (all models together). */
export const MAX_CONCURRENT_MODEL_WINDOWS = 6
export const MAX_PARALLEL_CONCURRENCY = 6

export const DEFAULT_STUDIO_MODEL_NAME: StudioModelOption = 'Argon'

export const ARGON_MAX_OUTPUT_TOKENS = 1_000_000
export const FLASH_DEFAULT_MAX_OUTPUT_TOKENS = 65_536

export type StudioThinkingLevel = 'high' | 'medium' | 'low'

export const DEFAULT_STUDIO_THINKING_LEVEL: StudioThinkingLevel = 'high'

export const QUOTA_RESET_TZ = 'America/Los_Angeles'

/**
 * Daily quota is per Google account, so each account slot has its own record.
 * Slot 1 keeps the original file name so existing state carries over.
 */
export type StudioAccountSlot = 1 | 2 | 3
function quotaRecordKey(accountSlot: number = 1): string {
  return accountSlot === 2 || accountSlot === 3
    ? `studio-model-quota-acct${accountSlot}.json`
    : 'studio-model-quota.json'
}
function normalizeAccountSlot(raw: unknown): StudioAccountSlot {
  const n = Number(raw)
  return n === 2 || n === 3 ? n : 1
}

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
 * Gemini 4 models are shown in AI Studio as "Gemini 4 <Name>" (slug gemini-4-<name>).
 * Carbon is listed only so its card is recognised (and never mistaken for another model);
 * it is not in STUDIO_MODEL_OPTIONS and is never selected.
 */
export const GEMINI4_NAMED_MODELS = ['Argon', 'Neon', 'Carbon', 'Hydrogen'] as const
export type Gemini4NamedModel = (typeof GEMINI4_NAMED_MODELS)[number]

/** Returns 'Argon' | 'Neon' | 'Carbon' | 'Hydrogen' when the text names one of them, else null. */
export function gemini4NamedModelIn(raw?: string | null): Gemini4NamedModel | null {
  const text = raw || ''
  for (const name of GEMINI4_NAMED_MODELS) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) return name
  }
  return null
}

/** AI Studio slug for a Gemini 4 named model, e.g. "gemini-4-neon". */
export function gemini4SlugFor(name: Gemini4NamedModel): string {
  return `gemini-4-${name.toLowerCase()}`
}

/**
 * Canonicalize to one of STUDIO_MODEL_OPTIONS:
 * - 'Argon' | 'Neon' | 'Hydrogen' (Gemini 4, matched by name)
 * - 'Gemini 3.8 Flash' | 'Gemini 3.6 Flash'
 * (3.7, Carbon and any unknown model map to 'Gemini 3.8 Flash').
 * Named models are checked first so a card like "Gemini 4 Hydrogen ..." is never
 * mistaken for a Flash model.
 */
export function canonicalizeStudioModelName(raw?: string | null): StudioModelOption {
  const trimmed = (raw || '').trim()
  if (!trimmed) return DEFAULT_STUDIO_MODEL_NAME
  const named = gemini4NamedModelIn(trimmed)
  if (named && named !== 'Carbon') return named
  if (/3\.8/.test(trimmed)) return 'Gemini 3.8 Flash'
  if (/3\.6/.test(trimmed)) return 'Gemini 3.6 Flash'
  if (/3\.7/.test(trimmed)) return 'Gemini 3.8 Flash'
  return 'Gemini 3.8 Flash'
}

/**
 * Whenever Argon is used, Output length (maxOutputTokens) MUST be 1,000,000 (1000000).
 * For every other model (Neon, Carbon, Hydrogen, Gemini 3.8 Flash, Gemini 3.6 Flash) use
 * 65,536 (or user setting <= 65,536) and leave AI Studio's Output length untouched.
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
 * across all STUDIO_MODEL_OPTIONS.
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
 * Build a complete fallback cycle across all STUDIO_MODEL_OPTIONS
 * starting from `chosenModel`.
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

/**
 * Model leases: which parallel worker (holderKey = its Chrome profile dir) is currently
 * working on which model. Kept on globalThis so every Next.js bundle in this process
 * (parallel manager + Studio automation) sees the same map.
 */
interface StudioModelLease {
  model: StudioModelOption
  /** Google account the worker was on when it took the lease (limits are per account) */
  account: StudioAccountSlot
  at: number
}
/** A lease not refreshed for this long belongs to a crashed / abandoned worker. */
const MODEL_LEASE_STALE_MS = 30 * 60_000

const globalForModelLeases = globalThis as unknown as {
  __cmtStudioModelLeases?: Map<string, StudioModelLease>
  __cmtStudioHolderAccounts?: Map<string, StudioAccountSlot>
}

function holderAccounts(): Map<string, StudioAccountSlot> {
  if (!globalForModelLeases.__cmtStudioHolderAccounts) {
    globalForModelLeases.__cmtStudioHolderAccounts = new Map()
  }
  return globalForModelLeases.__cmtStudioHolderAccounts
}

/** Which Google account a worker (holderKey = its profile dir) is using. Default 1. */
export function setStudioHolderAccount(holderKey: string, accountSlot: number): void {
  if (!holderKey) return
  const slot = normalizeAccountSlot(accountSlot)
  holderAccounts().set(holderKey, slot)
  // A lease taken on another account no longer counts for this worker
  const lease = globalForModelLeases.__cmtStudioModelLeases?.get(holderKey)
  if (lease && lease.account !== slot) globalForModelLeases.__cmtStudioModelLeases?.delete(holderKey)
}

export function getStudioHolderAccount(holderKey?: string): StudioAccountSlot {
  if (!holderKey) return 1
  return holderAccounts().get(holderKey) || 1
}
function modelLeases(): Map<string, StudioModelLease> {
  if (!globalForModelLeases.__cmtStudioModelLeases) {
    globalForModelLeases.__cmtStudioModelLeases = new Map()
  }
  return globalForModelLeases.__cmtStudioModelLeases
}

function pruneStaleModelLeases(nowMs: number = Date.now()) {
  for (const [holder, lease] of modelLeases()) {
    if (nowMs - lease.at > MODEL_LEASE_STALE_MS) modelLeases().delete(holder)
  }
}

export function maxWindowsForModel(model: string): number {
  return STUDIO_MODEL_MAX_WINDOWS[canonicalizeStudioModelName(model)] ?? DEFAULT_MAX_WINDOWS_PER_MODEL
}

/**
 * Number of windows OTHER than `holderKey` currently working on each model, on the same
 * Google account as `holderKey` (or on `accountSlot`; all accounts when neither is given).
 */
export function getActiveLeasedModelsByOtherHolders(
  holderKey?: string,
  nowMs: number = Date.now(),
  accountSlot?: number,
): Map<StudioModelOption, number> {
  pruneStaleModelLeases(nowMs)
  const account = holderKey ? getStudioHolderAccount(holderKey) : accountSlot ? normalizeAccountSlot(accountSlot) : null
  const counts = new Map<StudioModelOption, number>()
  for (const [holder, lease] of modelLeases()) {
    if (holderKey && holder === holderKey) continue
    if (account !== null && lease.account !== account) continue
    counts.set(lease.model, (counts.get(lease.model) || 0) + 1)
  }
  return counts
}

/** True when `holderKey` may take `model` without exceeding that model's window limit on its account. */
export function hasFreeModelSlot(model: string, holderKey?: string, nowMs: number = Date.now()): boolean {
  const canon = canonicalizeStudioModelName(model)
  const others = getActiveLeasedModelsByOtherHolders(holderKey, nowMs).get(canon) || 0
  return others < maxWindowsForModel(canon)
}

/** Record (or refresh) that `holderKey` is now working on `modelName`. */
export function updateExclusiveStudioModelLease(
  holderKey: string,
  modelName: string,
): StudioModelOption {
  const canon = canonicalizeStudioModelName(modelName)
  if (holderKey) {
    modelLeases().set(holderKey, { model: canon, account: getStudioHolderAccount(holderKey), at: Date.now() })
  }
  return canon
}

/** Free the worker's model slot when its window job ends (DONE / FAILED / STOPPED). */
export function releaseExclusiveStudioModel(holderKey?: string): void {
  if (holderKey) modelLeases().delete(holderKey)
}

/** e.g. "Argon 2/2 · 3.8 Flash 1/2 · Hydrogen 0/2 · Neon 0/2 · 3.6 Flash 0/2" (one account) */
export function describeStudioModelLeases(nowMs: number = Date.now(), accountSlot: number = 1): string {
  const counts = getActiveLeasedModelsByOtherHolders(undefined, nowMs, accountSlot)
  return STUDIO_MODEL_OPTIONS.map(
    (m) => `${m.replace(/^Gemini /, '')} ${counts.get(m) || 0}/${maxWindowsForModel(m)}`,
  ).join(' · ')
}

/**
 * Allowed models from `chain` (then every other allowed model), de-duplicated, with models
 * that still have a free window slot for `holderKey` first and full ones last.
 */
export function orderChainByUnleasedFirst(
  holderKey: string | undefined,
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
  const free = normalizedChain.filter((m) => hasFreeModelSlot(m, holderKey))
  const full = normalizedChain.filter((m) => !hasFreeModelSlot(m, holderKey))
  return [...free, ...full]
}

export function orderFallbacksKeepingTargetFirst(
  holderKey: string | undefined,
  targetModelName: string,
  chain: readonly string[],
): StudioModelOption[] {
  const targetCanon = canonicalizeStudioModelName(targetModelName)
  const rest = orderChainByUnleasedFirst(holderKey, chain).filter(
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
  accountSlot: number = 1,
): Promise<StudioModelQuotaState> {
  const saved = await readJSONRecord<StudioModelQuotaState>(quotaRecordKey(accountSlot))
  const rawExhausted =
    saved && saved.exhausted && typeof saved.exhausted === 'object' ? saved.exhausted : {}

  const cleaned: Record<string, number> = {}
  let changed = false

  for (const [modelKey, untilTs] of Object.entries(rawExhausted)) {
    if (/3\.7/.test(modelKey) || /\bcarbon\b/i.test(modelKey)) {
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

  // Read-only: expired entries are simply skipped here. Writing the cleaned copy back from a
  // reader raced with markModelExhausted() in parallel workers and could erase a model that
  // another worker had just marked exhausted. Writers below prune expired entries themselves.
  return {
    exhausted: cleaned,
    updatedAt: changed ? nowMs : saved?.updatedAt || nowMs,
  }
}

/**
 * Serialize every read-modify-write of the quota record across all parallel workers
 * (and across Next.js bundles, via globalThis) and always re-read the record from disk
 * first, so two workers marking two different models at the same moment both persist.
 */
const globalForQuotaLock = globalThis as unknown as { __cmtStudioQuotaLock?: Promise<unknown> }

async function withQuotaRecordLock<T>(accountSlot: number, fn: () => Promise<T>): Promise<T> {
  const prev = globalForQuotaLock.__cmtStudioQuotaLock || Promise.resolve()
  const run = prev.catch(() => undefined).then(async () => {
    invalidateJSONRecord(quotaRecordKey(accountSlot))
    return fn()
  })
  globalForQuotaLock.__cmtStudioQuotaLock = run.catch(() => undefined)
  return run
}

export async function markModelExhausted(
  model: string,
  nowMs: number = Date.now(),
  accountSlot: number = 1,
): Promise<{ model: string; untilTimestamp: number; state: StudioModelQuotaState }> {
  const canonical = canonicalizeStudioModelName(model)
  const untilTimestamp = nextPacificMidnight(nowMs)
  return withQuotaRecordLock(accountSlot, async () => {
    const current = await loadStudioModelQuotaState(nowMs, accountSlot)
    const nextState: StudioModelQuotaState = {
      exhausted: {
        ...current.exhausted,
        [canonical]: untilTimestamp,
      },
      updatedAt: nowMs,
    }
    await writeJSONRecord(quotaRecordKey(accountSlot), nextState)
    return { model: canonical, untilTimestamp, state: nextState }
  })
}

/**
 * Clear exhausted flags. `accountSlot` = one account only; omitted = every account
 * (the Settings "Reset" button). Returns account 1's new state.
 */
export async function resetModelQuotaState(
  model?: string | null,
  nowMs: number = Date.now(),
  accountSlot?: number,
): Promise<StudioModelQuotaState> {
  const slots = accountSlot ? [normalizeAccountSlot(accountSlot)] : [1, 2, 3]
  let first: StudioModelQuotaState | null = null
  for (const slot of slots) {
    const res = await withQuotaRecordLock(slot, async () => {
      const current = await loadStudioModelQuotaState(nowMs, slot)
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
      await writeJSONRecord(quotaRecordKey(slot), nextState)
      return nextState
    })
    if (!first) first = res
  }
  return first as StudioModelQuotaState
}

/**
 * True when every model this account may use has its daily quota used up
 * (`allowedModels` = the one fixed model, or all models in Auto mode).
 */
export async function isAccountFullyExhausted(
  accountSlot: number,
  nowMs: number = Date.now(),
  allowedModels: readonly string[] = STUDIO_MODEL_OPTIONS,
): Promise<boolean> {
  const state = await loadStudioModelQuotaState(nowMs, accountSlot)
  return allowedModels.map((m) => canonicalizeStudioModelName(m)).every((m) => {
    const untilTs = state.exhausted[m]
    return Boolean(untilTs && untilTs > nowMs)
  })
}

/**
 * First model in `order` whose daily quota is NOT used up on this account ('' if all are).
 * Used for fixed-model accounts: e.g. Only Neon -> Neon, then 3.6 Flash, Hydrogen, Argon.
 */
export async function firstModelWithQuota(
  order: readonly string[],
  accountSlot: number,
  nowMs: number = Date.now(),
): Promise<string> {
  const state = await loadStudioModelQuotaState(nowMs, accountSlot)
  for (const raw of order) {
    const m = canonicalizeStudioModelName(raw)
    const untilTs = state.exhausted[m]
    if (!untilTs || untilTs <= nowMs) return m
  }
  return ''
}

export interface EffectiveModelWaitOptions {
  /** Stop waiting for a free model slot (scan stopped). */
  isAborted?: () => boolean
  /** Called (at most every 30s) while every usable model is at its window limit. */
  onWaitForSlot?: (message: string) => void
  /** 0 = do not wait: return "" when no usable model has a free window slot. Otherwise waits. */
  maxWaitMs?: number
  /** Google account whose quota to check (default: the holder's account, else 1). */
  accountSlot?: number
}

/**
 * Starting from `chosenModel`, return the first model in `chain` that is not exhausted
 * (or whose `untilTimestamp <= nowMs`). Models in `excludeModels` are tried last.
 *
 * When `holderKey` (the worker's profile dir) is given, the per-model window limit
 * (STUDIO_MODEL_MAX_WINDOWS) is enforced and the chosen model is LEASED to that worker in
 * the same synchronous step, so two workers can never both take the last Argon slot.
 * If every non-exhausted model is at its limit, waits for a slot to free up.
 *
 * If all models in the chain are exhausted, returns `''` (empty string).
 */
export async function getEffectiveModel(
  chosenModel?: string | null,
  chain?: string[],
  nowMs: number = Date.now(),
  holderKey?: string,
  excludeModels?: string[],
  waitOptions?: EffectiveModelWaitOptions,
): Promise<string> {
  const baseChain = chain && chain.length > 0 ? chain : buildStudioFallbackCycle(chosenModel)
  const startCanonical = canonicalizeStudioModelName(chosenModel || baseChain[0])
  const startIdx = baseChain.findIndex(
    (m) => canonicalizeStudioModelName(m).toLowerCase() === startCanonical.toLowerCase(),
  )
  const rotatedChain =
    startIdx >= 0
      ? [...baseChain.slice(startIdx), ...baseChain.slice(0, startIdx)]
      : [...baseChain]

  // Only allowed models, each once, in chain order
  const orderedCandidates: StudioModelOption[] = []
  for (const c of rotatedChain) {
    const canon = canonicalizeStudioModelName(c)
    if (!orderedCandidates.includes(canon)) orderedCandidates.push(canon)
  }

  const excludedSet = new Set(
    (excludeModels || []).map((m) => canonicalizeStudioModelName(m).toLowerCase()),
  )
  // Preferred order: non-excluded models first, excluded ones only as a last resort
  const preferred = [
    ...orderedCandidates.filter((m) => !excludedSet.has(m.toLowerCase())),
    ...orderedCandidates.filter((m) => excludedSet.has(m.toLowerCase())),
  ]

  let lastWaitLogAt = 0
  const account = waitOptions?.accountSlot
    ? normalizeAccountSlot(waitOptions.accountSlot)
    : getStudioHolderAccount(holderKey)

  for (;;) {
    const now = holderKey ? Date.now() : nowMs
    const state = await loadStudioModelQuotaState(nowMs, account)
    const usable = preferred.filter((m) => {
      const untilTs = state.exhausted[m]
      return !untilTs || untilTs <= nowMs
    })
    if (usable.length === 0) return ''

    if (!holderKey) return usable[0]

    // Synchronous from here to the lease write: no other worker can grab the slot in between
    const withSlot = usable.find((m) => hasFreeModelSlot(m, holderKey, now))
    if (withSlot) {
      updateExclusiveStudioModelLease(holderKey, withSlot)
      return withSlot
    }

    // The window limit per model per account is never broken (no 3rd window on a model):
    // maxWaitMs 0 = "just look" -> '' when no model has a free slot; stopped -> first usable
    // model WITHOUT taking a lease; otherwise keep waiting for a free slot.
    if (waitOptions?.maxWaitMs === 0) return ''
    if (waitOptions?.isAborted?.()) return usable[0]
    if (Date.now() - lastWaitLogAt >= 30_000) {
      lastWaitLogAt = Date.now()
      waitOptions?.onWaitForSlot?.(
        `All usable models on Account ${account} are at their window limit (${describeStudioModelLeases(now, account)}) - waiting for a free model slot`,
      )
    }
    await new Promise((r) => setTimeout(r, 3_000))
  }
}
