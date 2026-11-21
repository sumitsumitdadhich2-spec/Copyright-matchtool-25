import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampStudioConcurrency,
  DEFAULT_STUDIO_PARALLEL_CONCURRENCY,
  isAmbiguousOrInternalErrorText,
  isModelUnavailableOrHighDemandError,
  isPermissionDeniedErrorText,
  isYouTubeAuthWallUrl,
  isYouTubeSelectChannelPromptUrl,
  MAX_STUDIO_PARALLEL_CONCURRENCY,
} from './studio-error-classifier'

test('clampStudioConcurrency defaults to 6, caps at 6, and allows 1..4 without legacy override', () => {
  assert.equal(DEFAULT_STUDIO_PARALLEL_CONCURRENCY, 6)
  assert.equal(MAX_STUDIO_PARALLEL_CONCURRENCY, 6)
  assert.equal(clampStudioConcurrency(undefined), 6)
  assert.equal(clampStudioConcurrency(null), 6)
  assert.equal(clampStudioConcurrency(10), 6)
  assert.equal(clampStudioConcurrency(12), 6)
  assert.equal(clampStudioConcurrency(6), 6)
  assert.equal(clampStudioConcurrency(4), 4)
  assert.equal(clampStudioConcurrency(3), 3)
  assert.equal(clampStudioConcurrency(1), 1)
  assert.equal(clampStudioConcurrency(0), 6)
  assert.equal(clampStudioConcurrency(-2), 6)
})

test('isModelUnavailableOrHighDemandError matches 503 and AI Studio turn error text', () => {
  assert.equal(
    isModelUnavailableOrHighDemandError(
      "Model 6:18 PM\n\nerror\nModel isn't available right now. Please wait a minute and try again.",
    ),
    true,
  )
  assert.equal(
    isModelUnavailableOrHighDemandError(
      '[14,"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later."]',
      503,
    ),
    true,
  )
  assert.equal(isModelUnavailableOrHighDemandError('Service is unavailable'), true)
  assert.equal(isModelUnavailableOrHighDemandError('ok', 503), true)
  assert.equal(isModelUnavailableOrHighDemandError('HISSA 1\n00:00 - 00:05', 200), false)
})

test('isPermissionDeniedErrorText matches 403 and toast permission denied text', () => {
  assert.equal(
    isPermissionDeniedErrorText('Failed to generate content: permission denied. Please try again.'),
    true,
  )
  assert.equal(
    isPermissionDeniedErrorText('[7,"The caller does not have permission"]', 403),
    true,
  )
  assert.equal(isPermissionDeniedErrorText('ok', 403), true)
  assert.equal(isPermissionDeniedErrorText('An internal error has occurred.', 500), false)
})

test('isAmbiguousOrInternalErrorText matches 404 Ambiguous request and 500 internal error but excludes 403 & 503', () => {
  assert.equal(
    isAmbiguousOrInternalErrorText('[5,"Ambiguous request for service /google.internal.alkali.applications.makersuite.v1.MakerSuiteService."]', 404),
    true,
  )
  assert.equal(isAmbiguousOrInternalErrorText('An internal error has occurred.', 500), true)
  assert.equal(
    isAmbiguousOrInternalErrorText('Failed to generate content: permission denied. Please try again.'),
    false,
  )
  assert.equal(
    isAmbiguousOrInternalErrorText("Model isn't available right now. Please wait a minute and try again.", 503),
    false,
  )
})

test('YouTube signin_prompt is recognized as channel picker, not Google Sign-In wall', () => {
  const promptUrl = 'https://www.youtube.com/signin_prompt?app=desktop&next=https%3A%2F%2Fstudio.youtube.com%2F'
  assert.equal(isYouTubeSelectChannelPromptUrl(promptUrl), true)
  assert.equal(isYouTubeAuthWallUrl(promptUrl), false)

  assert.equal(
    isYouTubeAuthWallUrl('https://accounts.google.com/v3/signin/identifier?continue=https://studio.youtube.com'),
    true,
  )
  assert.equal(
    isYouTubeAuthWallUrl('https://studio.youtube.com/channel/UCGM7R4BZJEjgKNXZ1F_D-Qg'),
    false,
  )
})
