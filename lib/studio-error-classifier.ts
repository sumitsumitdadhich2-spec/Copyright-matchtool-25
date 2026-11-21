/**
 * Pure classifiers & normalization helpers for AI Studio automation,
 * YouTube Studio login/channel-prompt detection, and parallel concurrency limits.
 */

export const MAX_STUDIO_PARALLEL_CONCURRENCY = 6
export const DEFAULT_STUDIO_PARALLEL_CONCURRENCY = 6

/**
 * Clamp requested Studio parallel worker concurrency to [1 .. 6].
 * Removes the legacy `<= 4 -> 10` override so any valid choice 1..6 is respected
 * and defaults/saved values > 6 cleanly cap to 6 to avoid RAM/CPU saturation.
 */
export function clampStudioConcurrency(
  raw: unknown,
  fallback: number = DEFAULT_STUDIO_PARALLEL_CONCURRENCY,
): number {
  const safeFallback = Math.max(
    1,
    Math.min(MAX_STUDIO_PARALLEL_CONCURRENCY, Math.round(Number(fallback) || DEFAULT_STUDIO_PARALLEL_CONCURRENCY)),
  )
  if (raw === undefined || raw === null || raw === '') {
    return safeFallback
  }
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 1) {
    return safeFallback
  }
  return Math.max(1, Math.min(MAX_STUDIO_PARALLEL_CONCURRENCY, Math.round(num)))
}

/**
 * Detect temporary model-unavailable / high-demand / HTTP 503 errors where
 * switching to another model in the fallback chain (e.g. Argon <-> Gemini 3.8 Flash)
 * recovers much faster than retrying the same overloaded model.
 */
export function isModelUnavailableOrHighDemandError(
  text?: string | null,
  httpStatus?: number | null,
): boolean {
  if (httpStatus === 503) return true
  const s = (text || '').trim()
  if (!s) return false
  return /(model\s+isn['’]t\s+available\s+right\s+now|model\s+is\s+(?:not|currently)\s+available|please\s+wait\s+a\s+minute\s+and\s+try\s+again|currently\s+experiencing\s+high\s+demand|experiencing\s+high\s+demand|service\s+is\s+(?:currently\s+)?unavailable|temporarily\s+unavailable|model\s+is\s+overloaded|overloaded\.?\s*please\s+try\s+again|\bUNAVAILABLE\b|\[14,\s*"This\s+model\s+is\s+currently)/i.test(
    s,
  )
}

/**
 * Detect 403 / permission denied errors from either network status/body or AI Studio toast banners
 * (e.g. "Failed to generate content: permission denied. Please try again.").
 */
export function isPermissionDeniedErrorText(
  text?: string | null,
  httpStatus?: number | null,
): boolean {
  if (httpStatus === 403) return true
  const s = (text || '').trim()
  if (!s) return false
  return /(permission[_\s]+denied|caller\s+does\s+not\s+have\s+permission|does\s+not\s+have\s+permission|failed\s+to\s+generate\s+content:\s*permission\s+denied)/i.test(
    s,
  )
}

/**
 * Detect transient internal/backend errors (HTTP 500, HTTP 404 Ambiguous request,
 * "An internal error has occurred", "Something went wrong", "Failed to generate content")
 * that are NOT permission denied or quota/daily limit.
 */
export function isAmbiguousOrInternalErrorText(
  text?: string | null,
  httpStatus?: number | null,
): boolean {
  if (isPermissionDeniedErrorText(text, httpStatus)) return false
  if (isModelUnavailableOrHighDemandError(text, httpStatus)) return false
  if (httpStatus === 500 || httpStatus === 404) return true
  const s = (text || '').trim()
  if (!s) return false
  return /(an\s+internal\s+error\s+has\s+occurred|internal\s+error(?:\s+has\s+occurred|\s+encountered)?|something\s+went\s+wrong|failed\s+to\s+generate(?:\s+content)?|ambiguous\s+request(?:\s+for\s+service)?|\bINTERNAL\b)/i.test(
    s,
  )
}

/**
 * Detect YouTube's post-login "Select a channel" interstitial (`youtube.com/signin_prompt`),
 * which is NOT a logged-out Google Sign-In wall — clicking the target channel enters Studio directly.
 */
export function isYouTubeSelectChannelPromptUrl(url?: string | null): boolean {
  const u = (url || '').trim().toLowerCase()
  return u.includes('youtube.com/signin_prompt') || u.includes('youtube.com/channel_switcher')
}

/**
 * Detect a true Google Sign-In / authentication wall (excluding YouTube's Select-a-channel prompt).
 */
export function isYouTubeAuthWallUrl(url?: string | null): boolean {
  const u = (url || '').trim()
  if (!u) return false
  if (isYouTubeSelectChannelPromptUrl(u)) return false
  return (
    u.includes('accounts.google.com') ||
    u.includes('ServiceLogin') ||
    /\/signin(?:[/?#]|$)/i.test(u)
  )
}
