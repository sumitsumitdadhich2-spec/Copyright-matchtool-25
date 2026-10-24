import { NextRequest, NextResponse } from 'next/server'
import { studioController } from '@/lib/studio-automation'
import { studioParallelManager } from '@/lib/studio-parallel-manager'
import { getSession } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  }
  if (!studioController.canUserAccessStudio(session)) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden: Studio browser is currently loaded for another user' },
      { status: 403 },
    )
  }

  const once = req.nextUrl.searchParams.get('once') === '1'
  if (once) {
    const [snap, parallelSnapshot] = await Promise.all([
      studioController.getSnapshot(true),
      studioParallelManager.getLiveSnapshot(true),
    ])
    return NextResponse.json({ ...snap, parallelSnapshot })
  }

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = async () => {
        if (closed) return
        try {
          const [snap, parallelSnapshot] = await Promise.all([
            studioController.getSnapshot(true),
            studioParallelManager.getLiveSnapshot(true),
          ])
          const payload = `data: ${JSON.stringify({ ...snap, parallelSnapshot })}\n\n`
          controller.enqueue(encoder.encode(payload))
        } catch {
          /* ignore */
        }
      }

      await send()
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer)
          return
        }
        void send()
      }, 1000)

      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          /* ignore */
        }
      })
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
