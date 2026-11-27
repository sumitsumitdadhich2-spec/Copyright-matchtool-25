import { NextResponse } from 'next/server'
import { getSession } from '@/lib/users'
import { enqueueBackgroundScan } from '@/lib/background-queue'
import { getAllUserApiKeys, setUserVerifierEnabled } from '@/lib/user-keys'
import { deductTokens, refundTokens, SCAN_TOKEN_COST } from '@/lib/tokens'
import { isMinuteFinderRunning } from '@/lib/gemini-minute-finder'
import { getScan, saveScan } from '@/lib/store'
import { loadStudioUserConfig } from '@/lib/studio-settings'

export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan || (session.role !== 'admin' && scan.ownerUsername !== session.username)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  let resume = false
  try {
    const body = (await req.json()) as { resume?: boolean }
    resume = Boolean(body.resume)
  } catch {
    // no body
  }

  // While the Gemini Minute Finder runs, Start / Resume are off: the finder starts the chunk
  // scan itself when it is done. To scan right away, Stop the finder first (finder panel).
  if (isMinuteFinderRunning(id)) {
    return NextResponse.json(
      {
        error:
          'Gemini Minute Finder abhi chal raha hai — khatam hote hi scan apne aap start hoga. Abhi scan chahiye to pehle finder panel me Stop dabao.',
        minuteFinderRunning: true,
      },
      { status: 409 },
    )
  }

  await loadStudioUserConfig(session.username)
  scan.chunkScanEngine = 'studio'
  scan.verifierEnabled = false
  saveScan(scan)

  // TOKENS: 1 fresh scan = 100 tokens. Resume is free (already paid).
  // Admin (shiva) has unlimited tokens and never gets charged.
  let charged = false
  if (session.role !== 'admin' && !resume) {
    const newBalance = await deductTokens(session.username, SCAN_TOKEN_COST)
    if (newBalance === null) {
      return NextResponse.json(
        { error: `Tokens khatm ho gaye hain! 1 scan = ${SCAN_TOKEN_COST} tokens. Admin se tokens lo.`, tokensExhausted: true },
        { status: 402 },
      )
    }
    charged = true
  }

  // Finder could have started between the check above and here: never stop it from Start.
  if (isMinuteFinderRunning(id)) {
    if (charged) await refundTokens(session.username, SCAN_TOKEN_COST)
    return NextResponse.json(
      { error: 'Gemini Minute Finder abhi chal raha hai — pehle finder panel me Stop dabao.', minuteFinderRunning: true },
      { status: 409 },
    )
  }

  const result = await enqueueBackgroundScan(id, session.username, resume)
  if (!result.ok) {
    // Scan didn't enter the queue — give the tokens back.
    if (charged) await refundTokens(session.username, SCAN_TOKEN_COST)
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
  return NextResponse.json({ ok: true, queued: true })
}
