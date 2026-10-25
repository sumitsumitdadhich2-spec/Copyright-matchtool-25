import assert from 'node:assert/strict'
import {
  cleanStudioAnswerText,
  isPromptEchoText,
  validateStudioAnswer,
} from '../lib/studio-result-validator'
import { extractHissa1And2EntriesFromResponse } from '../lib/studio-window-planner'
import { shiftMovieTimestampsInHissa2 } from '../lib/studio-clip-offset'
import { buildStudioChunkPrompt } from '../lib/studio-prompt'

// 1. Completely flattened (0-newline) DOM output with UI icon noise + Grounding footer + duration token
const flattenedWithNoise = [
  'edit more_vert Thinking Initiating Video Analysis Let me check the frames carefully.',
  '===================== HISSA 1 — SHORT VIDEO TIME MAP =====================',
  '00:00.000 - 00:01.000 (0-24 frames): Actor walks into the room and says "Kahan jaa rahe ho?"',
  '00:01.000 - 00:02.500 (24-60 frames): Close-up of door closing quickly',
  '===================== HISSA 2 — MOVIE MAP TIME =====================',
  'Short 00:00.000 - 00:01.000 --> Movie 01:10.000 - 01:11.000 (1680-1704 frames)',
  'Short 00:01.000 - 00:02.500 --> NOT FOUND — ye scene is movie window me nahi hai',
  'Sources help Google Search Suggestions Display of Search Suggestions is required when using Grounding with Google Search. Learn more thumb_upthumb_down 6m31.5s',
].join(' ')

assert.equal(
  (flattenedWithNoise.match(/\n/g) || []).length,
  0,
  'Input flattenedWithNoise must have 0 newlines',
)

const cleanedFlattened = cleanStudioAnswerText(flattenedWithNoise)
assert.ok(cleanedFlattened.startsWith('HISSA 1'), 'Should start at HISSA 1 after cleaning')
assert.ok(!cleanedFlattened.includes('edit'), 'Should strip leading edit token')
assert.ok(!cleanedFlattened.includes('more_vert'), 'Should strip leading more_vert token')
assert.ok(!cleanedFlattened.includes('Sources help'), 'Should strip Grounding Sources block')
assert.ok(!cleanedFlattened.includes('thumb_up'), 'Should strip thumb_up/thumb_down tokens')
assert.ok(!cleanedFlattened.includes('6m31.5s'), 'Should strip duration token 6m31.5s')
assert.ok(
  (cleanedFlattened.match(/\n/g) || []).length >= 4,
  'Cleaned text should have restored newlines for HISSA 1, HISSA 2, and Short lines',
)

const valFlattened = validateStudioAnswer(flattenedWithNoise, { shortWindowSec: 2.5 })
assert.equal(valFlattened.ok, true, `Expected flattened answer to validate OK, got: ${valFlattened.reason}`)
assert.equal(valFlattened.stats.matchLineCount, 1)
assert.equal(valFlattened.stats.notFoundLineCount, 1)
assert.equal(valFlattened.stats.totalValidHissa2Lines, 2)

// Verify parallel parser and clip-offset shifter also work on the cleaned flattened text
const shiftedFlattened = shiftMovieTimestampsInHissa2(valFlattened.cleanedText, 2400) // +100s
assert.ok(
  shiftedFlattened.includes('Movie 02:50.000 - 02:51.000 (4080-4104 frames)'),
  'Clip offset shift should work on cleaned flattened text',
)
const parallelParsed = extractHissa1And2EntriesFromResponse(shiftedFlattened)
assert.equal(parallelParsed.hissa1Entries.length, 2, 'Should parse 2 HISSA 1 entries')
assert.equal(parallelParsed.hissa2Entries.length, 2, 'Should parse 2 HISSA 2 entries')

// 2. Normal multiline text with DOM noise & grounding block
const multilineWithNoise = `edit
more_vert
Thoughts
Analyzing 24fps frames...
=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
00:00.000 - 00:01.500 (0-36 frames): Hero looks at the train station clock
00:01.500 - 00:03.000 (36-72 frames): Train arrives on platform 2

=====================
HISSA 2 — MOVIE MAP TIME
=====================
Short 00:00.000 - 00:01.500 --> Movie 00:20.000 - 00:21.500 (480-516 frames)
Short 00:01.500 - 00:03.000 --> Movie 00:21.500 - 00:23.000 (516-552 frames)
Sources help
1. example.com
Google Search Suggestions
Display of Search Suggestions is required when using Grounding with Google Search. Learn more
thumb_up
thumb_down
12.4s`

const valMultiline = validateStudioAnswer(multilineWithNoise, { shortWindowSec: 3.0 })
assert.equal(valMultiline.ok, true, `Expected multiline answer to validate OK, got: ${valMultiline.reason}`)
assert.equal(valMultiline.stats.matchLineCount, 2)
assert.equal(valMultiline.stats.notFoundLineCount, 0)
assert.ok(!valMultiline.cleanedText.includes('Sources help'))
assert.ok(!valMultiline.cleanedText.includes('12.4s'))

// 3. Prompt text must be rejected as 'prompt_echo'
const promptText = buildStudioChunkPrompt({ movieWindowSec: 300, shortPartSec: 30 })
assert.equal(isPromptEchoText(promptText), true, 'Prompt must be detected by isPromptEchoText')
const valPrompt = validateStudioAnswer(promptText, { shortWindowSec: 30 })
assert.equal(valPrompt.ok, false, 'Prompt text must NEVER pass validateStudioAnswer')
assert.equal(valPrompt.reason, 'prompt_echo')

// 4. Truncated stream must still be rejected as 'truncated_last_line'
const truncatedAnswer = `HISSA 1 — SHORT VIDEO TIME MAP
00:00.000 - 00:01.000 (0-24 frames): Scene one
00:01.000 - 00:02.000 (24-48 frames): Scene two
HISSA 2 — MOVIE MAP TIME
Short 00:00.000 - 00:01.000 --> Movie 00:12.000 - 00:13.000 (288-312 frames)
Short 00:01.000 - 00:02.000 --> Movie 00:13.0`
const valTruncated = validateStudioAnswer(truncatedAnswer, { shortWindowSec: 2.0 })
assert.equal(valTruncated.ok, false)
assert.equal(valTruncated.reason, 'truncated_last_line')

console.log('ALL STUDIO VALIDATOR & CLEANER TESTS PASSED!')
