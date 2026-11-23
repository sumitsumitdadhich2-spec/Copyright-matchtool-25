import crypto from 'crypto'
import { readJSONRecord, writeJSONRecord } from './json-record'
import {
  ARGON_MAX_OUTPUT_TOKENS,
  STUDIO_MODEL_OPTIONS,
  type StudioModelOption,
  canonicalizeStudioModelName,
  DEFAULT_STUDIO_MODEL_NAME,
  DEFAULT_STUDIO_THINKING_LEVEL,
  getEffectiveModel,
  loadStudioModelQuotaState,
  normalizeStudioThinkingLevel,
  resolveEffectiveMaxOutputTokensForModel,
  type StudioThinkingLevel,
} from './studio-model-state'
import type { ChunkScanEngine } from './types'
import {
  clampStudioConcurrency,
  DEFAULT_STUDIO_PARALLEL_CONCURRENCY,
  MAX_STUDIO_PARALLEL_CONCURRENCY,
} from './studio-error-classifier'

/** Google account slots for AI Studio workers. Slot 1 = the original Settings cookies. */
export type GoogleAccountSlot = 1 | 2 | 3
export const GOOGLE_ACCOUNT_SLOTS: GoogleAccountSlot[] = [1, 2, 3]

export function normalizeGoogleAccountSlot(raw: unknown): GoogleAccountSlot {
  const n = Number(raw)
  return n === 2 || n === 3 ? n : 1
}

/** Extra Google account (slot 2 / 3): same fields as the slot-1 cookies on StudioUserConfig. */
export interface GoogleAccountRecord {
  /** Encrypted JSON string (Cookie-Editor array or Playwright storageState) — NEVER sent to client */
  encryptedCookies?: string
  lastLoginEmail?: string | null
  lastLoginStatus?: 'logged_in' | 'logged_out' | 'untested'
  lastLoginTestedAt?: number | null
}

/** 'auto' = start from the Settings model and fall back across all allowed models (default). */
export type GoogleAccountModelMode = 'auto' | StudioModelOption
/** 'default' = Medium. */
export type GoogleAccountThinking = 'default' | StudioThinkingLevel

/** Per-account run settings chosen under each account's cookies. */
export interface GoogleAccountRunSettings {
  modelMode: GoogleAccountModelMode
  thinking: GoogleAccountThinking
}

export const DEFAULT_ACCOUNT_THINKING_LEVEL: StudioThinkingLevel = 'medium'

export function normalizeAccountModelMode(raw: unknown): GoogleAccountModelMode {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().toLowerCase() === 'auto') return 'auto'
  const direct = STUDIO_MODEL_OPTIONS.find((m) => m.toLowerCase() === raw.trim().toLowerCase())
  if (direct) return direct
  // Only a name that clearly means one of the allowed models (never Carbon / unknown -> Auto)
  if (/carbon/i.test(raw)) return 'auto'
  if (/argon|neon|hydrogen|3\.8|3\.6/i.test(raw)) return canonicalizeStudioModelName(raw)
  return 'auto'
}

export function normalizeAccountThinking(raw: unknown): GoogleAccountThinking {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw
  return 'default'
}

/** Thinking level actually used for an account ('default' -> Medium). */
export function resolveAccountThinkingLevel(thinking: GoogleAccountThinking): StudioThinkingLevel {
  return thinking === 'default' ? DEFAULT_ACCOUNT_THINKING_LEVEL : thinking
}

/**
 * Fixed-model accounts that may move on to other models ONLY when the fixed model's daily
 * quota is used up, in this order. 403 / 503 / internal errors still stay on the current model.
 *   Only Neon: Neon -> Gemini 3.6 Flash -> Hydrogen -> Argon (last)
 * A fixed model not listed here never falls back.
 */
export const FIXED_MODEL_QUOTA_FALLBACK: Partial<Record<StudioModelOption, StudioModelOption[]>> = {
  Neon: ['Gemini 3.6 Flash', 'Hydrogen', 'Argon'],
}

/**
 * Models an account may use, in quota order: every allowed model in Auto mode, else the fixed
 * model followed by its quota fallbacks (FIXED_MODEL_QUOTA_FALLBACK).
 */
export function allowedModelsForAccountMode(mode: GoogleAccountModelMode): StudioModelOption[] {
  if (mode === 'auto') return [...STUDIO_MODEL_OPTIONS]
  return [mode, ...(FIXED_MODEL_QUOTA_FALLBACK[mode] ?? []).filter((m) => m !== mode)]
}

export interface PublicGoogleAccount {
  slot: GoogleAccountSlot
  /** 'auto' or the one model this account is fixed to */
  modelMode: GoogleAccountModelMode
  /** 'default' (= Medium) | 'high' | 'medium' | 'low' */
  thinking: GoogleAccountThinking
  hasCookies: boolean
  cookieCount: number
  lastLoginEmail: string | null
  lastLoginStatus: 'logged_in' | 'logged_out' | 'untested'
  lastLoginTestedAt: number | null
  /** Models whose daily quota is exhausted on THIS account (model -> reset timestamp) */
  exhaustedModels: Record<string, number>
}

export interface StudioUserConfig {
  chunkScanEngine: ChunkScanEngine
  studioModelName: string
  studioThinkingLevel: StudioThinkingLevel
  studioMaxOutputTokens: number
  /** Optional override for max input tokens before shrinking; null/0 = auto (1_048_576 - studioMaxOutputTokens - 5_000) */
  studioMaxInputTokens: number | null
  /** Close and reopen Playwright page in the same persistent context after every N finished window jobs (default 5) */
  studioPageRecycleInterval: number
  studioWindowMinutes: number
  studioShortPartMinutes: number
  studioWindowOverlapSec: number
  /** Calibrated offset mode when start/end clip timestamps are set in AI Studio:
   *  - 'auto': not yet calibrated; first job with startSec >= 60 auto-detects and saves 'relative' or 'absolute'
   *  - 'relative': Studio returns timestamps relative to the clip start (00:00 = clip startSec)
   *  - 'absolute': Studio returns timestamps relative to the original video (00:00 = video 00:00)
   */
  studioOffsetMode: 'auto' | 'relative' | 'absolute'
  /** Encrypted JSON string (Cookie-Editor array or Playwright storageState) — NEVER sent to client */
  encryptedCookies?: string
  /** Last verified login state */
  lastLoginEmail?: string | null
  lastLoginStatus?: 'logged_in' | 'logged_out' | 'untested'
  lastLoginTestedAt?: number | null
  /** Google accounts 2 and 3 (account 1 = encryptedCookies / lastLogin* above) */
  extraGoogleAccounts?: Partial<Record<'2' | '3', GoogleAccountRecord>>
  /** Model mode + thinking per Google account (all 3 slots) */
  googleAccountRunSettings?: Partial<Record<'1' | '2' | '3', Partial<GoogleAccountRunSettings>>>
  /** Encrypted Google Drive OAuth token bundle — NEVER sent to client */
  encryptedDriveTokens?: string
  driveConnectedEmail?: string | null
  driveConnectedAt?: number | null
  /** Parallel Window Scan worker concurrency (default 4) */
  studioConcurrency?: number
  /** Max concurrent workers allowed in media upload/attach gate (default 2) */
  studioUploadGateConcurrency?: number
  /** Stagger timer between pressing Run on different windows across all workers (seconds, default 20) */
  studioRunStaggerSec?: number
  /** Movie minute input list/ranges for Parallel Window Scan */
  studioMinuteInput?: string
  /** Measured token rate (tokens/sec at 24 FPS) from Test Clip */
  studioMeasuredTokenRate?: number | null
  /** A/B Toggle: Low-memory Chrome flags (--disable-gpu, --disable-extensions, --disable-background-networking) (default false / OFF) */
  studioLowMemoryChromeFlags?: boolean
  /** A/B Toggle: --disable-dev-shm-usage flag for Chrome (default true / ON) */
  studioDisableDevShmUsage?: boolean
  /** Attach movie_360p from Google Drive Picker instead of uploading 378 MB locally in browser (default false / OFF) */
  studioAttachMovieFromDrive?: boolean
  /** Encrypted YouTube Studio cookies JSON — NEVER sent to client */
  encryptedYtCookies?: string
  ytChannelId?: string | null
  ytChannelHandle?: string | null
  ytLastLoginStatus?: 'logged_in' | 'logged_out' | 'untested'
  ytLastLoginTestedAt?: number | null
  ytVisibility?: 'unlisted' | 'private' | 'public'
  ytAutoDeleteAtEnd?: boolean
  ytUploadConcurrency?: number
  updatedAt: number
}

export interface PublicStudioSettings {
  chunkScanEngine: ChunkScanEngine
  studioModelName: string
  studioEffectiveModelName: string
  studioThinkingLevel: StudioThinkingLevel
  studioExhaustedModels: Record<string, number>
  studioMaxOutputTokens: number
  studioMaxInputTokens: number | null
  effectiveMaxInputTokens: number
  studioPageRecycleInterval: number
  studioWindowMinutes: number
  studioShortPartMinutes: number
  studioWindowOverlapSec: number
  studioOffsetMode: 'auto' | 'relative' | 'absolute'
  studioConcurrency: number
  studioUploadGateConcurrency: number
  studioRunStaggerSec: number
  studioMinuteInput: string
  studioMeasuredTokenRate: number | null
  studioLowMemoryChromeFlags: boolean
  studioDisableDevShmUsage: boolean
  studioAttachMovieFromDrive: boolean
  hasCookies: boolean
  cookieCount: number
  /** All 3 Google account slots (1 = the cookies above) with their login + quota status */
  googleAccounts: PublicGoogleAccount[]
  lastLoginEmail: string | null
  lastLoginStatus: 'logged_in' | 'logged_out' | 'untested'
  lastLoginTestedAt: number | null
  hasYtCookies: boolean
  ytCookieCount: number
  ytChannelId: string | null
  ytChannelHandle: string | null
  ytLastLoginStatus: 'logged_in' | 'logged_out' | 'untested'
  ytLastLoginTestedAt: number | null
  ytVisibility: 'unlisted' | 'private' | 'public'
  ytAutoDeleteAtEnd: boolean
  ytUploadConcurrency: number
  driveConnected: boolean
  driveConnectedEmail: string | null
  driveConnectedAt: number | null
  oauthClientConfigured: boolean
}

export interface DriveTokenBundle {
  refresh_token: string
  access_token?: string
  expiry_date?: number
  email?: string
}

export interface PlaywrightCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export const STUDIO_CONTEXT_WINDOW_TOKENS = 1_048_576
export const STUDIO_SAFETY_MARGIN_TOKENS = 5_000

/**
 * Compute the input token shrink threshold:
 * Default (auto): 1_048_576 - 65_536 - 5_000 = 978_040 (even when Argon output length is set to 1_000_000).
 * If user sets a custom studioMaxInputTokens > 0, use that override.
 */
export function computeEffectiveMaxInputTokens(
  maxOutputTokens: number,
  customMaxInputTokens?: number | null,
): number {
  if (
    typeof customMaxInputTokens === 'number' &&
    Number.isFinite(customMaxInputTokens) &&
    customMaxInputTokens > 0
  ) {
    return Math.floor(customMaxInputTokens)
  }
  const out = Math.max(1024, Math.min(65536, Number(maxOutputTokens) || 65536))
  return STUDIO_CONTEXT_WINDOW_TOKENS - out - STUDIO_SAFETY_MARGIN_TOKENS
}

export const DEFAULT_STUDIO_CONCURRENCY = DEFAULT_STUDIO_PARALLEL_CONCURRENCY
export const DEFAULT_STUDIO_UPLOAD_GATE = 2
export const DEFAULT_YT_UPLOAD_CONCURRENCY = 3
export const DEFAULT_STUDIO_RUN_STAGGER_SEC = 20
export const DEFAULT_STUDIO_MINUTE_INPUT =
  '7,8,9,10,14,15,16,17,19,20,21,25-41,48-54,56,57,58,63-67,71-100'

export const DEFAULT_STUDIO_CONFIG: StudioUserConfig = {
  chunkScanEngine: 'studio',
  studioModelName: DEFAULT_STUDIO_MODEL_NAME,
  studioThinkingLevel: DEFAULT_STUDIO_THINKING_LEVEL,
  studioMaxOutputTokens: ARGON_MAX_OUTPUT_TOKENS,
  studioMaxInputTokens: null,
  studioPageRecycleInterval: 5,
  studioWindowMinutes: 5,
  studioShortPartMinutes: 3,
  studioWindowOverlapSec: 0,
  studioOffsetMode: 'auto',
  studioConcurrency: DEFAULT_STUDIO_CONCURRENCY,
  studioUploadGateConcurrency: DEFAULT_STUDIO_UPLOAD_GATE,
  studioRunStaggerSec: DEFAULT_STUDIO_RUN_STAGGER_SEC,
  studioMinuteInput: DEFAULT_STUDIO_MINUTE_INPUT,
  studioMeasuredTokenRate: null,
  studioLowMemoryChromeFlags: false,
  studioDisableDevShmUsage: true,
  studioAttachMovieFromDrive: false,
  lastLoginStatus: 'untested',
  ytLastLoginStatus: 'untested',
  ytVisibility: 'unlisted',
  ytAutoDeleteAtEnd: true,
  ytUploadConcurrency: DEFAULT_YT_UPLOAD_CONCURRENCY,
  updatedAt: 0,
}

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET || 'cmt-default-session-secret-change-me'
  return crypto.scryptSync(secret, 'cmt-studio-aes-salt-v1', 32)
}

export function encryptSecret(plainText: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export function decryptSecret(cipherText: string): string {
  const parts = (cipherText || '').split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format')
  const [ivB64, tagB64, dataB64] = parts
  const key = getEncryptionKey()
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(data), decipher.final()])
  return dec.toString('utf8')
}

function recordKey(username: string): string {
  const safe = (username || 'admin').toLowerCase().replace(/[^a-z0-9._-]/g, '_')
  return `auth/studio/${safe}.json`
}

export async function loadStudioUserConfig(username: string): Promise<StudioUserConfig> {
  let raw = await readJSONRecord<Partial<StudioUserConfig>>(recordKey(username))
  for (const altUser of ['shiva', 'admin']) {
    if (altUser === (username || 'admin').toLowerCase()) continue
    const altRaw = await readJSONRecord<Partial<StudioUserConfig>>(recordKey(altUser))
    if (altRaw) {
      const preferAltYtStatus =
        altRaw.ytLastLoginStatus === 'logged_in' ||
        (!raw?.ytLastLoginStatus || raw.ytLastLoginStatus === 'untested')
      const preferAltStudioStatus =
        altRaw.lastLoginStatus === 'logged_in' ||
        (!raw?.lastLoginStatus || raw.lastLoginStatus === 'untested')

      raw = {
        ...altRaw,
        ...(raw || {}),
        encryptedCookies: raw?.encryptedCookies || altRaw.encryptedCookies,
        lastLoginEmail: raw?.lastLoginEmail || altRaw.lastLoginEmail,
        lastLoginStatus: preferAltStudioStatus
          ? altRaw.lastLoginStatus || raw?.lastLoginStatus
          : raw?.lastLoginStatus,
        lastLoginTestedAt: Math.max(
          raw?.lastLoginTestedAt || 0,
          altRaw.lastLoginTestedAt || 0,
        ) || null,
        encryptedYtCookies: raw?.encryptedYtCookies || altRaw.encryptedYtCookies,
        ytChannelId: raw?.ytChannelId || altRaw.ytChannelId,
        ytChannelHandle: raw?.ytChannelHandle || altRaw.ytChannelHandle,
        ytLastLoginStatus: preferAltYtStatus
          ? altRaw.ytLastLoginStatus || raw?.ytLastLoginStatus
          : raw?.ytLastLoginStatus,
        ytLastLoginTestedAt: Math.max(
          raw?.ytLastLoginTestedAt || 0,
          altRaw.ytLastLoginTestedAt || 0,
        ) || null,
      }
    }
  }
  const rawModel = (raw?.studioModelName || '').trim()
  const resolvedModelName =
    !rawModel || rawModel === 'Gemini 2.5 Pro' || rawModel === 'Gemini 3.8 Pro'
      ? DEFAULT_STUDIO_CONFIG.studioModelName
      : canonicalizeStudioModelName(rawModel)
  const studioMaxOutputTokens = resolveEffectiveMaxOutputTokensForModel(
    resolvedModelName,
    raw?.studioMaxOutputTokens,
  )
  const rawMaxInput = raw?.studioMaxInputTokens
  const studioMaxInputTokens =
    typeof rawMaxInput === 'number' && Number.isFinite(rawMaxInput) && rawMaxInput > 0
      ? Math.max(50_000, Math.min(1_048_576, Math.floor(rawMaxInput)))
      : null
  const studioPageRecycleInterval = Math.max(
    1,
    Math.min(100, Math.floor(Number(raw?.studioPageRecycleInterval) || DEFAULT_STUDIO_CONFIG.studioPageRecycleInterval)),
  )

  const studioThinkingLevel = normalizeStudioThinkingLevel(raw?.studioThinkingLevel)

  return {
    ...DEFAULT_STUDIO_CONFIG,
    ...(raw || {}),
    chunkScanEngine: 'studio',
    studioModelName: resolvedModelName,
    studioThinkingLevel,
    studioMaxOutputTokens,
    studioMaxInputTokens,
    studioPageRecycleInterval,
    studioWindowMinutes: Math.max(1, Math.min(15, Number(raw?.studioWindowMinutes) || DEFAULT_STUDIO_CONFIG.studioWindowMinutes)),
    studioShortPartMinutes: Math.max(1, Math.min(10, Number(raw?.studioShortPartMinutes) || DEFAULT_STUDIO_CONFIG.studioShortPartMinutes)),
    studioWindowOverlapSec: Math.max(0, Math.min(60, Number(raw?.studioWindowOverlapSec ?? DEFAULT_STUDIO_CONFIG.studioWindowOverlapSec))),
    studioOffsetMode:
      raw?.studioOffsetMode === 'relative' || raw?.studioOffsetMode === 'absolute'
        ? raw.studioOffsetMode
        : 'auto',
    studioConcurrency: clampStudioConcurrency(raw?.studioConcurrency, DEFAULT_STUDIO_CONCURRENCY),
    studioUploadGateConcurrency: Math.max(
      1,
      Math.min(
        MAX_STUDIO_PARALLEL_CONCURRENCY,
        Math.round(Number(raw?.studioUploadGateConcurrency) || DEFAULT_STUDIO_UPLOAD_GATE),
      ),
    ),
    studioRunStaggerSec: Math.max(
      5,
      Math.min(120, Math.round(Number(raw?.studioRunStaggerSec) || DEFAULT_STUDIO_RUN_STAGGER_SEC)),
    ),
    studioMinuteInput:
      typeof raw?.studioMinuteInput === 'string' && raw.studioMinuteInput.trim()
        ? raw.studioMinuteInput.trim()
        : DEFAULT_STUDIO_MINUTE_INPUT,
    studioMeasuredTokenRate:
      typeof raw?.studioMeasuredTokenRate === 'number' &&
      Number.isFinite(raw.studioMeasuredTokenRate) &&
      raw.studioMeasuredTokenRate > 50 &&
      raw.studioMeasuredTokenRate < 5000
        ? Math.round(raw.studioMeasuredTokenRate * 10) / 10
        : null,
    studioLowMemoryChromeFlags: Boolean(raw?.studioLowMemoryChromeFlags ?? false),
    studioDisableDevShmUsage:
      raw?.studioDisableDevShmUsage !== undefined ? Boolean(raw.studioDisableDevShmUsage) : true,
    studioAttachMovieFromDrive: Boolean(raw?.studioAttachMovieFromDrive ?? false),
    ytVisibility:
      raw?.ytVisibility === 'public'
        ? 'public'
        : raw?.ytVisibility === 'private'
          ? 'private'
          : 'unlisted',
    ytAutoDeleteAtEnd: raw?.ytAutoDeleteAtEnd !== undefined ? Boolean(raw.ytAutoDeleteAtEnd) : true,
    ytUploadConcurrency: Math.max(
      1,
      Math.min(10, Math.round(Number(raw?.ytUploadConcurrency) || DEFAULT_YT_UPLOAD_CONCURRENCY)),
    ),
    ytLastLoginStatus:
      raw?.ytLastLoginStatus === 'logged_in' || raw?.ytLastLoginStatus === 'logged_out'
        ? raw.ytLastLoginStatus
        : 'untested',
    ytChannelId: raw?.ytChannelId || null,
    ytChannelHandle: raw?.ytChannelHandle || null,
    ytLastLoginTestedAt: raw?.ytLastLoginTestedAt ?? null,
  }
}

export async function saveStudioUserConfig(
  username: string,
  patch: Partial<StudioUserConfig>,
): Promise<StudioUserConfig> {
  const current = await loadStudioUserConfig(username)
  const nextModelName = patch.studioModelName
    ? canonicalizeStudioModelName(patch.studioModelName)
    : current.studioModelName
  const nextMaxOut = resolveEffectiveMaxOutputTokensForModel(
    nextModelName,
    patch.studioMaxOutputTokens !== undefined
      ? patch.studioMaxOutputTokens
      : current.studioMaxOutputTokens,
  )
  const nextConcurrency =
    patch.studioConcurrency !== undefined
      ? clampStudioConcurrency(patch.studioConcurrency, DEFAULT_STUDIO_CONCURRENCY)
      : clampStudioConcurrency(current.studioConcurrency, DEFAULT_STUDIO_CONCURRENCY)
  const next: StudioUserConfig = {
    ...current,
    ...patch,
    studioModelName: nextModelName,
    studioMaxOutputTokens: nextMaxOut,
    studioConcurrency: nextConcurrency,
    chunkScanEngine: 'studio',
    updatedAt: Date.now(),
  }
  await writeJSONRecord(recordKey(username), next)
  return next
}

/**
 * Parse either Cookie-Editor JSON array or Playwright storageState JSON
 * into normalized Playwright cookies.
 */
/** Fix the usual copy-paste damage before giving up on a cookie JSON paste. */
function repairCookieJsonText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"') // smart double quotes
    .replace(/,(\s*[}\]])/g, '$1') // trailing commas: {..., } / [..., ]
    .replace(/\]\s*,?\s*\[/g, ',') // two exports pasted one after another: [...][...]
    .trim()
}

/** Netscape cookies.txt (7 tab-separated columns) -> Cookie-Editor-like objects. */
function parseNetscapeCookiesTxt(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    }
    if (!line || line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    const [domain, , cookiePath, secure, expires, name, ...rest] = cols
    out.push({
      domain,
      path: cookiePath || '/',
      secure: /^true$/i.test(secure),
      expirationDate: Number(expires) || undefined,
      name,
      value: rest.join('\t'),
      httpOnly,
    })
  }
  return out
}

/**
 * Last resort for any cookie export whose JSON is damaged: cut the text into { ... } blocks and
 * read name / value / domain / path / expiry / flags from each block with tolerant regexes.
 */
function extractCookieObjectsLoosely(text: string): Array<Record<string, unknown>> {
  const norm = text.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'")
  const field = (block: string, key: string): string | null => {
    const re = new RegExp(`["']?\\b${key}\\b["']?\\s*[:=]\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|([^,}\\s]+))`, 'i')
    const m = block.match(re)
    if (!m) return null
    return (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\"/g, '"')
  }
  const out: Array<Record<string, unknown>> = []
  for (const block of norm.split('}')) {
    const name = field(block, 'name')
    const domain = field(block, 'domain')
    const value = field(block, 'value')
    // A block without a value is a cookie cut off by the copy/paste: skip it
    if (!name || !domain || value === null) continue
    const exp = Number(field(block, 'expirationDate') ?? field(block, 'expires') ?? '')
    out.push({
      name,
      value,
      domain,
      path: field(block, 'path') || '/',
      ...(Number.isFinite(exp) && exp > 0 ? { expirationDate: exp } : {}),
      httpOnly: /^true$/i.test(field(block, 'httpOnly') || ''),
      secure: !/^false$/i.test(field(block, 'secure') || 'true'),
      ...(field(block, 'sameSite') ? { sameSite: field(block, 'sameSite') } : {}),
    })
  }
  return out
}

/** Cookie-Editor "Header String" export: "NAME=value; NAME2=value2" (Google cookies -> .google.com). */
function parseCookieHeaderString(text: string): Array<Record<string, unknown>> {
  const t = text.replace(/^cookie:\s*/i, '').trim()
  if (!t || /[{}\[\]\n]/.test(t) || !t.includes('=')) return []
  return t
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => {
      const idx = part.indexOf('=')
      return { name: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim(), domain: '.google.com', path: '/' }
    })
    .filter((c) => c.name)
}

/** "line 115, col 26" + the text around it, so the user can see what broke. */
function describeJsonErrorPosition(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/position\s+(\d+)/i)
  if (!m) return msg
  const pos = Number(m[1])
  const before = text.slice(0, pos)
  const line = before.split('\n').length
  const lineText = (text.split('\n')[line - 1] || '').trim()
  const shown = lineText.length > 90 ? `${lineText.slice(0, 90)}…` : lineText
  return `${msg} — line ${line}: ${shown}`
}

export function parseCookieInputToPlaywright(rawJson: string): PlaywrightCookie[] {
  const trimmed = (rawJson || '').trim()
  if (!trimmed) throw new Error('Cookies JSON is empty')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (firstErr) {
    const fallbacks: Array<() => unknown> = [
      () => JSON.parse(repairCookieJsonText(trimmed)),
      () => parseNetscapeCookiesTxt(trimmed),
      () => extractCookieObjectsLoosely(trimmed),
      () => parseCookieHeaderString(trimmed),
    ]
    for (const tryParse of fallbacks) {
      try {
        const res = tryParse()
        const list = Array.isArray(res)
          ? res
          : res && typeof res === 'object' && Array.isArray((res as { cookies?: unknown[] }).cookies)
            ? (res as { cookies: unknown[] }).cookies
            : null
        if (list && list.length > 0) {
          parsed = res
          break
        }
      } catch {
        /* try the next format */
      }
    }
    if (parsed === undefined) {
      throw new Error(
        `Could not read any cookies: ${describeJsonErrorPosition(trimmed, firstErr)}. ` +
          'Export again from Cookie-Editor (Export -> JSON) on aistudio.google.com and paste the whole text.',
      )
    }
  }

  let rawList: unknown[] = []
  if (Array.isArray(parsed)) {
    rawList = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown[] }).cookies)) {
    rawList = (parsed as { cookies: unknown[] }).cookies
  } else {
    throw new Error('Cookies JSON must be a Cookie-Editor JSON array [...] or Playwright storageState {"cookies": [...]}')
  }

  const out: PlaywrightCookie[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    const value = typeof c.value === 'string' ? c.value : ''
    const domain = typeof c.domain === 'string' ? c.domain.trim() : ''
    if (!name || !domain) continue
    const cookiePath = typeof c.path === 'string' && c.path ? c.path : '/'
    const rawExp = Number(c.expirationDate ?? c.expires ?? -1)
    const expires = Number.isFinite(rawExp) && rawExp > 0 ? rawExp : undefined
    const httpOnly = Boolean(c.httpOnly)
    const secure = c.secure !== undefined ? Boolean(c.secure) : true

    let sameSite: 'Strict' | 'Lax' | 'None' | undefined
    if (typeof c.sameSite === 'string') {
      const s = c.sameSite.toLowerCase()
      if (s === 'strict') sameSite = 'Strict'
      else if (s === 'lax') sameSite = 'Lax'
      else if (s === 'no_restriction' || s === 'none') sameSite = 'None'
    }
    if (sameSite === 'None' && !secure) {
      sameSite = 'Lax'
    }

    out.push({
      name,
      value,
      domain,
      path: cookiePath,
      ...(expires ? { expires } : {}),
      httpOnly,
      secure,
      ...(sameSite ? { sameSite } : {}),
    })
  }

  if (out.length === 0) {
    throw new Error('No valid Google cookies found in the provided JSON.')
  }
  // Same cookie pasted twice: keep the last copy
  const byKey = new Map<string, PlaywrightCookie>()
  for (const c of out) byKey.set(`${c.name}|${c.domain}|${c.path}`, c)
  return [...byKey.values()]
}

/** Read one account's record (slot 1 maps onto the original top-level fields). */
function getGoogleAccountRecord(cfg: StudioUserConfig, slot: GoogleAccountSlot): GoogleAccountRecord {
  if (slot === 1) {
    return {
      encryptedCookies: cfg.encryptedCookies,
      lastLoginEmail: cfg.lastLoginEmail ?? null,
      lastLoginStatus: cfg.lastLoginStatus ?? 'untested',
      lastLoginTestedAt: cfg.lastLoginTestedAt ?? null,
    }
  }
  return cfg.extraGoogleAccounts?.[String(slot) as '2' | '3'] || {}
}

/** Patch one account's record (slot 1 = top-level fields, 2/3 = extraGoogleAccounts). */
export async function patchGoogleAccountRecord(
  username: string,
  slot: GoogleAccountSlot,
  patch: GoogleAccountRecord,
): Promise<void> {
  if (slot === 1) {
    await saveStudioUserConfig(username, patch)
    return
  }
  const cfg = await loadStudioUserConfig(username)
  const key = String(slot) as '2' | '3'
  const merged: GoogleAccountRecord = { ...(cfg.extraGoogleAccounts?.[key] || {}), ...patch }
  if (!merged.encryptedCookies) delete merged.encryptedCookies
  await saveStudioUserConfig(username, {
    extraGoogleAccounts: { ...(cfg.extraGoogleAccounts || {}), [key]: merged },
  })
}

export async function saveUserGoogleCookies(
  username: string,
  rawCookieJson: string,
  slot: GoogleAccountSlot = 1,
): Promise<{ count: number }> {
  const cookies = parseCookieInputToPlaywright(rawCookieJson)
  const encryptedCookies = encryptSecret(JSON.stringify(cookies))
  await patchGoogleAccountRecord(username, slot, {
    encryptedCookies,
    lastLoginStatus: 'untested',
    lastLoginEmail: null,
    lastLoginTestedAt: null,
  })
  return { count: cookies.length }
}

export async function clearUserGoogleCookies(username: string, slot: GoogleAccountSlot = 1): Promise<void> {
  await patchGoogleAccountRecord(username, slot, {
    encryptedCookies: undefined,
    lastLoginStatus: 'untested',
    lastLoginEmail: null,
    lastLoginTestedAt: null,
  })
}

export async function recordGoogleAccountLoginTest(
  username: string,
  slot: GoogleAccountSlot,
  result: { loggedIn: boolean; email: string | null },
): Promise<void> {
  await patchGoogleAccountRecord(username, slot, {
    lastLoginStatus: result.loggedIn ? 'logged_in' : 'logged_out',
    lastLoginEmail: result.email,
    lastLoginTestedAt: Date.now(),
  })
}

export async function loadDecryptedPlaywrightCookies(
  username: string,
  slot: GoogleAccountSlot = 1,
): Promise<PlaywrightCookie[]> {
  const cfg = await loadStudioUserConfig(username)
  const rec = getGoogleAccountRecord(cfg, slot)
  if (rec.encryptedCookies) {
    try {
      const plain = decryptSecret(rec.encryptedCookies)
      const parsed = parseCookieInputToPlaywright(plain)
      if (parsed.length > 0) return parsed
    } catch {
      return []
    }
  }
  return []
}

/**
 * Account slots the parallel workers may use: every slot that has cookies, minus slots whose
 * last Test login said "logged out" (unless that would leave none). Never empty: [1] fallback.
 */
export async function getActiveGoogleAccountSlots(username: string): Promise<GoogleAccountSlot[]> {
  const cfg = await loadStudioUserConfig(username)
  const withCookies = GOOGLE_ACCOUNT_SLOTS.filter((slot) =>
    Boolean(getGoogleAccountRecord(cfg, slot).encryptedCookies),
  )
  if (withCookies.length === 0) return [1]
  const notLoggedOut = withCookies.filter(
    (slot) => getGoogleAccountRecord(cfg, slot).lastLoginStatus !== 'logged_out',
  )
  return notLoggedOut.length > 0 ? notLoggedOut : withCookies
}

export function readGoogleAccountRunSettings(
  cfg: StudioUserConfig,
  slot: GoogleAccountSlot,
): GoogleAccountRunSettings {
  const raw = cfg.googleAccountRunSettings?.[String(slot) as '1' | '2' | '3'] || {}
  return {
    modelMode: normalizeAccountModelMode(raw.modelMode),
    thinking: normalizeAccountThinking(raw.thinking),
  }
}

export async function getGoogleAccountRunSettings(
  username: string,
  slot: GoogleAccountSlot,
): Promise<GoogleAccountRunSettings> {
  return readGoogleAccountRunSettings(await loadStudioUserConfig(username), slot)
}

export async function saveGoogleAccountRunSettings(
  username: string,
  slot: GoogleAccountSlot,
  patch: Partial<GoogleAccountRunSettings>,
): Promise<GoogleAccountRunSettings> {
  const cfg = await loadStudioUserConfig(username)
  const current = readGoogleAccountRunSettings(cfg, slot)
  const next: GoogleAccountRunSettings = {
    modelMode: patch.modelMode !== undefined ? normalizeAccountModelMode(patch.modelMode) : current.modelMode,
    thinking: patch.thinking !== undefined ? normalizeAccountThinking(patch.thinking) : current.thinking,
  }
  await saveStudioUserConfig(username, {
    googleAccountRunSettings: { ...(cfg.googleAccountRunSettings || {}), [String(slot)]: next },
  })
  return next
}

export async function getGoogleAccountEmail(
  username: string,
  slot: GoogleAccountSlot,
): Promise<string | null> {
  const cfg = await loadStudioUserConfig(username)
  return getGoogleAccountRecord(cfg, slot).lastLoginEmail ?? null
}

export async function saveUserYtCookies(username: string, rawCookieJson: string): Promise<{ count: number }> {
  const cookies = parseCookieInputToPlaywright(rawCookieJson)
  const encryptedYtCookies = encryptSecret(JSON.stringify(cookies))
  await saveStudioUserConfig(username, {
    encryptedYtCookies,
    ytChannelId: null,
    ytChannelHandle: null,
    ytLastLoginStatus: 'untested',
    ytLastLoginTestedAt: null,
  })
  return { count: cookies.length }
}

export async function loadDecryptedPlaywrightYtCookies(username: string): Promise<PlaywrightCookie[]> {
  const cfg = await loadStudioUserConfig(username)
  if (cfg.encryptedYtCookies) {
    try {
      const plain = decryptSecret(cfg.encryptedYtCookies)
      const parsed = parseCookieInputToPlaywright(plain)
      if (parsed.length > 0) return parsed
    } catch {
      return []
    }
  }
  return []
}

export async function clearUserYtCookies(username: string): Promise<void> {
  await saveStudioUserConfig(username, {
    encryptedYtCookies: undefined,
    ytChannelId: null,
    ytChannelHandle: null,
    ytLastLoginStatus: 'untested',
    ytLastLoginTestedAt: null,
  })
}

export async function getSettingsCookieFingerprint(
  username: string,
  slot: GoogleAccountSlot = 1,
): Promise<string> {
  const cookies = await loadDecryptedPlaywrightCookies(username, slot)
  if (cookies.length === 0) return 'NONE'
  const canonical = JSON.stringify(
    cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
  )
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export async function saveUserDriveTokens(username: string, bundle: DriveTokenBundle): Promise<void> {
  const encryptedDriveTokens = encryptSecret(JSON.stringify(bundle))
  await saveStudioUserConfig(username, {
    encryptedDriveTokens,
    driveConnectedEmail: bundle.email || null,
    driveConnectedAt: Date.now(),
  })
}

export async function loadUserDriveTokens(username: string): Promise<DriveTokenBundle | null> {
  const cfg = await loadStudioUserConfig(username)
  if (!cfg.encryptedDriveTokens) return null
  try {
    const plain = decryptSecret(cfg.encryptedDriveTokens)
    const parsed = JSON.parse(plain) as DriveTokenBundle
    if (!parsed || typeof parsed.refresh_token !== 'string' || !parsed.refresh_token) return null
    return parsed
  } catch {
    return null
  }
}

export async function getPublicStudioSettings(username: string): Promise<PublicStudioSettings> {
  const cfg = await loadStudioUserConfig(username)
  let cookieCount = 0
  if (cfg.encryptedCookies) {
    try {
      const cookies = JSON.parse(decryptSecret(cfg.encryptedCookies))
      if (Array.isArray(cookies)) cookieCount = cookies.length
    } catch {
      cookieCount = 0
    }
  }
  let ytCookieCount = 0
  if (cfg.encryptedYtCookies) {
    try {
      const ytCookies = JSON.parse(decryptSecret(cfg.encryptedYtCookies))
      if (Array.isArray(ytCookies)) ytCookieCount = ytCookies.length
    } catch {
      ytCookieCount = 0
    }
  }
  let driveConnected = false
  if (cfg.encryptedDriveTokens) {
    try {
      const tokens = JSON.parse(decryptSecret(cfg.encryptedDriveTokens)) as DriveTokenBundle
      driveConnected = Boolean(tokens?.refresh_token)
    } catch {
      driveConnected = false
    }
  }

  const quotaState = await loadStudioModelQuotaState()
  const effectiveModel =
    (await getEffectiveModel(cfg.studioModelName)) || cfg.studioModelName

  const googleAccounts: PublicGoogleAccount[] = []
  for (const slot of GOOGLE_ACCOUNT_SLOTS) {
    const rec = getGoogleAccountRecord(cfg, slot)
    let count = 0
    if (rec.encryptedCookies) {
      try {
        const parsed = JSON.parse(decryptSecret(rec.encryptedCookies))
        if (Array.isArray(parsed)) count = parsed.length
      } catch {
        count = 0
      }
    }
    const runSettings = readGoogleAccountRunSettings(cfg, slot)
    googleAccounts.push({
      slot,
      modelMode: runSettings.modelMode,
      thinking: runSettings.thinking,
      hasCookies: count > 0,
      cookieCount: count,
      lastLoginEmail: rec.lastLoginEmail ?? null,
      lastLoginStatus: rec.lastLoginStatus ?? 'untested',
      lastLoginTestedAt: rec.lastLoginTestedAt ?? null,
      exhaustedModels: (await loadStudioModelQuotaState(Date.now(), slot)).exhausted,
    })
  }

  return {
    chunkScanEngine: cfg.chunkScanEngine,
    studioModelName: cfg.studioModelName,
    studioEffectiveModelName: effectiveModel,
    studioThinkingLevel: cfg.studioThinkingLevel,
    studioExhaustedModels: quotaState.exhausted,
    studioMaxOutputTokens: cfg.studioMaxOutputTokens,
    studioMaxInputTokens: cfg.studioMaxInputTokens ?? null,
    effectiveMaxInputTokens: computeEffectiveMaxInputTokens(
      cfg.studioMaxOutputTokens,
      cfg.studioMaxInputTokens,
    ),
    studioPageRecycleInterval: cfg.studioPageRecycleInterval ?? 5,
    studioWindowMinutes: cfg.studioWindowMinutes,
    studioShortPartMinutes: cfg.studioShortPartMinutes,
    studioWindowOverlapSec: cfg.studioWindowOverlapSec,
    studioOffsetMode: cfg.studioOffsetMode,
    studioConcurrency: cfg.studioConcurrency ?? DEFAULT_STUDIO_CONCURRENCY,
    studioUploadGateConcurrency: cfg.studioUploadGateConcurrency ?? DEFAULT_STUDIO_UPLOAD_GATE,
    studioRunStaggerSec: cfg.studioRunStaggerSec ?? DEFAULT_STUDIO_RUN_STAGGER_SEC,
    studioMinuteInput: cfg.studioMinuteInput || DEFAULT_STUDIO_MINUTE_INPUT,
    studioMeasuredTokenRate: cfg.studioMeasuredTokenRate ?? null,
    studioLowMemoryChromeFlags: Boolean(cfg.studioLowMemoryChromeFlags ?? false),
    studioDisableDevShmUsage:
      cfg.studioDisableDevShmUsage !== undefined ? Boolean(cfg.studioDisableDevShmUsage) : true,
    studioAttachMovieFromDrive: Boolean(cfg.studioAttachMovieFromDrive ?? false),
    hasCookies: cookieCount > 0,
    cookieCount,
    googleAccounts,
    lastLoginEmail: cfg.lastLoginEmail ?? null,
    lastLoginStatus: cfg.lastLoginStatus ?? 'untested',
    lastLoginTestedAt: cfg.lastLoginTestedAt ?? null,
    hasYtCookies: ytCookieCount > 0,
    ytCookieCount,
    ytChannelId: cfg.ytChannelId ?? null,
    ytChannelHandle: cfg.ytChannelHandle ?? null,
    ytLastLoginStatus: cfg.ytLastLoginStatus ?? 'untested',
    ytLastLoginTestedAt: cfg.ytLastLoginTestedAt ?? null,
    ytVisibility: cfg.ytVisibility ?? 'unlisted',
    ytAutoDeleteAtEnd: cfg.ytAutoDeleteAtEnd !== undefined ? Boolean(cfg.ytAutoDeleteAtEnd) : true,
    ytUploadConcurrency: cfg.ytUploadConcurrency ?? DEFAULT_YT_UPLOAD_CONCURRENCY,
    driveConnected,
    driveConnectedEmail: cfg.driveConnectedEmail ?? null,
    driveConnectedAt: cfg.driveConnectedAt ?? null,
    oauthClientConfigured: Boolean(
      process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    ),
  }
}
