import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../lib/paths'
import {
  buildStudioModelChain,
  canonicalizeStudioModelName,
  getActiveLeasedModelsByOtherHolders,
  hasFreeModelSlot,
  isAccountFullyExhausted,
  setStudioHolderAccount,
  releaseExclusiveStudioModel,
  getEffectiveModel,
  loadStudioModelQuotaState,
  markModelExhausted,
  nextPacificMidnight,
  resetModelQuotaState,
} from '../lib/studio-model-state'

async function runTests() {
  const statePath = path.join(DATA_DIR, 'studio-model-state.json')
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null

  try {
    // 1. Test nextPacificMidnight across 2 dates (PST winter UTC-8 and PDT summer UTC-7 + DST boundary)
    const winterNow = Date.parse('2026-01-15T18:30:00.000Z') // 2026-01-15 10:30 PST (UTC-8)
    const winterMidnight = nextPacificMidnight(winterNow)
    const expectedWinterMidnight = Date.parse('2026-01-16T08:00:00.000Z') // 2026-01-16 00:00 PST
    assert.equal(
      winterMidnight,
      expectedWinterMidnight,
      `Winter PST midnight mismatch: got ${new Date(winterMidnight).toISOString()}, expected ${new Date(expectedWinterMidnight).toISOString()}`,
    )

    const summerNow = Date.parse('2026-07-15T18:30:00.000Z') // 2026-07-15 11:30 PDT (UTC-7)
    const summerMidnight = nextPacificMidnight(summerNow)
    const expectedSummerMidnight = Date.parse('2026-07-16T07:00:00.000Z') // 2026-07-16 00:00 PDT
    assert.equal(
      summerMidnight,
      expectedSummerMidnight,
      `Summer PDT midnight mismatch: got ${new Date(summerMidnight).toISOString()}, expected ${new Date(expectedSummerMidnight).toISOString()}`,
    )

    // DST transition day (2026-03-08: PST -> PDT)
    const dstSpringNow = Date.parse('2026-03-08T09:30:00.000Z') // 2026-03-08 01:30 PST (before 2am spring forward)
    const dstSpringMidnight = nextPacificMidnight(dstSpringNow)
    const expectedDstSpringMidnight = Date.parse('2026-03-09T07:00:00.000Z') // 2026-03-09 00:00 PDT (UTC-7)
    assert.equal(
      dstSpringMidnight,
      expectedDstSpringMidnight,
      `DST spring-forward midnight mismatch: got ${new Date(dstSpringMidnight).toISOString()}`,
    )

    // 2. Test buildStudioModelChain order
    assert.deepEqual(buildStudioModelChain('Argon'), [
      'Argon',
      'Gemini 3.8 Flash',
      'Hydrogen',
      'Neon',
      'Gemini 3.6 Flash',
    ])
    assert.deepEqual(buildStudioModelChain('Gemini 3.8 Flash'), [
      'Gemini 3.8 Flash',
      'Hydrogen',
      'Neon',
      'Gemini 3.6 Flash',
      'Argon',
    ])
    assert.deepEqual(buildStudioModelChain('Neon'), [
      'Neon',
      'Gemini 3.6 Flash',
      'Argon',
      'Gemini 3.8 Flash',
      'Hydrogen',
    ])

    // 2b. AI Studio model cards are canonicalized by name (Hydrogen is AI Studio's default card
    // and used to be misread as "Gemini 3.8 Flash")
    const hydrogenCard =
      'Gemini 4 Hydrogen gemini-4-hydrogen An efficient model with cutting-edge intelligence for fast, dependable execution'
    assert.equal(canonicalizeStudioModelName(hydrogenCard), 'Hydrogen')
    assert.equal(canonicalizeStudioModelName('gemini-4-neon'), 'Neon')
    // Carbon is not usable on this account: never returned as a model option
    assert.equal(canonicalizeStudioModelName('Gemini 4 Carbon'), 'Gemini 3.8 Flash')
    assert.equal(canonicalizeStudioModelName('Gemini 4 Argon gemini-4-argon'), 'Argon')
    assert.equal(canonicalizeStudioModelName('Gemini 3.6 Flash gemini-3.6-flash'), 'Gemini 3.6 Flash')
    assert.equal(canonicalizeStudioModelName('Gemini 3.7 Flash'), 'Gemini 3.8 Flash')

    // 3. Test getEffectiveModel: Argon exhausted -> Gemini 3.8 Flash; after reset time -> back to Argon
    await resetModelQuotaState()
    const baseNow = Date.parse('2026-10-25T14:00:00.000Z') // 2026-10-25 07:00 PDT
    const initialEffective = await getEffectiveModel('Argon', undefined, baseNow)
    assert.equal(initialEffective, 'Argon', 'Initial effective model should be Argon')

    const { untilTimestamp } = await markModelExhausted('Argon', baseNow)
    assert.equal(
      untilTimestamp,
      Date.parse('2026-10-26T07:00:00.000Z'),
      'Argon exhaustion timestamp should equal next Pacific midnight',
    )

    const duringExhaustion = await getEffectiveModel('Argon', undefined, baseNow + 60_000)
    assert.equal(
      duringExhaustion,
      'Gemini 3.8 Flash',
      'When Argon is exhausted, getEffectiveModel("Argon") must return "Gemini 3.8 Flash"',
    )

    // After Pacific midnight reset time passes -> automatically returns to Argon and clears state
    const afterReset = await getEffectiveModel('Argon', undefined, untilTimestamp + 1000)
    assert.equal(
      afterReset,
      'Argon',
      'After reset time passes, getEffectiveModel("Argon") must return "Argon"',
    )
    const cleanedState = await loadStudioModelQuotaState(untilTimestamp + 1000)
    assert.equal(
      cleanedState.exhausted['Argon'],
      undefined,
      'Expired Argon entry should be removed from studio-model-state.json',
    )

    // 4. Two workers marking two different models at the same moment must BOTH persist
    // (the old read-modify-write lost one of them, so an exhausted model was retried later)
    await resetModelQuotaState(null, baseNow)
    await Promise.all([
      markModelExhausted('Argon', baseNow),
      markModelExhausted('Gemini 3.8 Flash', baseNow),
      markModelExhausted('Neon', baseNow),
    ])
    const concurrentState = await loadStudioModelQuotaState(baseNow + 1000)
    assert.ok(concurrentState.exhausted['Argon'], 'Argon must stay marked exhausted')
    assert.ok(concurrentState.exhausted['Gemini 3.8 Flash'], '3.8 Flash must stay marked exhausted')
    assert.ok(concurrentState.exhausted['Neon'], 'Neon must stay marked exhausted')
    const nextAfterThree = await getEffectiveModel('Argon', undefined, baseNow + 1000)
    assert.equal(nextAfterThree, 'Hydrogen', 'Next free model after Argon/3.8/Neon is Hydrogen')
    await resetModelQuotaState(null, baseNow)

    // 5. Per-model window limit: max 2 windows on the same model at once.
    // 6 workers all asking for Argon -> Argon, Argon, 3.8, 3.8, Hydrogen, Hydrogen
    const workers = ['w01', 'w02', 'w03', 'w04', 'w05', 'w06']
    const assigned: string[] = []
    for (const w of workers) {
      assigned.push(await getEffectiveModel('Argon', undefined, Date.now(), `lease-test-${w}`))
    }
    assert.deepEqual(assigned, [
      'Argon',
      'Argon',
      'Gemini 3.8 Flash',
      'Gemini 3.8 Flash',
      'Hydrogen',
      'Hydrogen',
    ])
    const counts = getActiveLeasedModelsByOtherHolders()
    assert.equal(counts.get('Argon'), 2, 'Never more than 2 windows on Argon')

    // A worker that already holds Argon keeps it (its own slot is not counted against it)
    assert.equal(await getEffectiveModel('Argon', undefined, Date.now(), 'lease-test-w01'), 'Argon')

    // w03 (3.8) hits an error and falls back excluding 3.8: Argon/Hydrogen are full -> Neon
    assert.equal(
      await getEffectiveModel('Argon', undefined, Date.now(), 'lease-test-w03', ['Gemini 3.8 Flash']),
      'Neon',
    )

    // When an Argon window finishes, the next window can take Argon again
    releaseExclusiveStudioModel('lease-test-w01')
    assert.equal(await getEffectiveModel('Argon', undefined, Date.now(), 'lease-test-w07'), 'Argon')
    assert.ok(hasFreeModelSlot('Gemini 3.6 Flash', 'lease-test-w08'))
    assert.ok(!hasFreeModelSlot('Argon', 'lease-test-w08'), 'Argon is full again (w02 + w07)')

    for (const w of [...workers, 'w07']) releaseExclusiveStudioModel(`lease-test-${w}`)
    assert.equal(getActiveLeasedModelsByOtherHolders().size, 0)

    // 6. Multiple Google accounts: quota and model limits are per account
    await resetModelQuotaState(null, baseNow)
    await markModelExhausted('Argon', Date.now(), 2)
    setStudioHolderAccount('acct-test-a1', 1)
    setStudioHolderAccount('acct-test-a2', 2)
    assert.equal(await getEffectiveModel('Argon', undefined, Date.now(), 'acct-test-a1'), 'Argon', 'Account 1 Argon still free')
    assert.equal(
      await getEffectiveModel('Argon', undefined, Date.now(), 'acct-test-a2'),
      'Gemini 3.8 Flash',
      'Account 2 Argon quota used -> 3.8 Flash',
    )
    // Two Argon windows on account 1 do not block Argon on account 3
    setStudioHolderAccount('acct-test-a1b', 1)
    setStudioHolderAccount('acct-test-a3', 3)
    assert.equal(await getEffectiveModel('Argon', undefined, Date.now(), 'acct-test-a1b'), 'Argon')
    assert.ok(!hasFreeModelSlot('Argon', 'acct-test-a1c-unregistered'), 'Account 1 Argon full (2/2)')
    assert.equal(await getEffectiveModel('Argon', undefined, Date.now(), 'acct-test-a3'), 'Argon', 'Account 3 has its own 2 Argon slots')
    assert.equal(await isAccountFullyExhausted(2), false)
    for (const m of ['Gemini 3.8 Flash', 'Hydrogen', 'Neon', 'Gemini 3.6 Flash']) {
      await markModelExhausted(m, Date.now(), 2)
    }
    assert.equal(await isAccountFullyExhausted(2), true, 'Account 2: every model used up')
    assert.equal(await isAccountFullyExhausted(1), false, 'Account 1 unaffected')
    // Account fixed to one model: out of quota as soon as THAT model is used up
    await markModelExhausted('Neon', Date.now(), 1)
    assert.equal(await isAccountFullyExhausted(1, Date.now(), ['Neon']), true, 'Neon-only account 1 is out')
    assert.equal(await isAccountFullyExhausted(1, Date.now(), ['Argon']), false, 'Argon-only account 1 still has quota')
    // A fixed chain never falls back to another model (free account 1's two Argon slots first)
    releaseExclusiveStudioModel('acct-test-a1')
    releaseExclusiveStudioModel('acct-test-a1b')
    setStudioHolderAccount('acct-test-fixed', 1)
    assert.equal(await getEffectiveModel('Neon', ['Neon'], Date.now(), 'acct-test-fixed'), '', 'Neon-only: no fallback')
    assert.equal(await getEffectiveModel('Argon', ['Argon'], Date.now(), 'acct-test-fixed', ['Argon']), 'Argon')
    releaseExclusiveStudioModel('acct-test-fixed')
    for (const h of ['acct-test-a1', 'acct-test-a2', 'acct-test-a1b', 'acct-test-a3']) releaseExclusiveStudioModel(h)
    await resetModelQuotaState(null, baseNow)
    assert.equal(await isAccountFullyExhausted(2), false, 'Reset clears every account')

    console.log('ALL TESTS PASSED: nextPacificMidnight (PST/PDT/DST), model chain, canonicalize, getEffectiveModel, per-model window limits & per-account quota')
  } finally {
    if (backup !== null) {
      fs.writeFileSync(statePath, backup, 'utf8')
    } else if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true })
    }
  }
}

runTests().catch((err) => {
  console.error(err)
  process.exit(1)
})
