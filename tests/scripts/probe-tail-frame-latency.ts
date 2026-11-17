import { inflateSync } from 'node:zlib'
import puppeteer, { type CDPSession } from 'puppeteer-core'

// Measures how long Chrome takes to deliver the screencast frame that shows a
// paint: the page turns a new solid colour after a quiet spell, and the probe
// times the first frame showing it from the page's own Date.now(). The stop
// path's tail-frame wait is sized from these numbers. Not part of any suite.
//
// With PROBE_PAIR=1 each change paints twice, one animation frame apart, and
// the probe reports the gap between the arrivals of the two frames instead:
// how far apart two frames Chrome has in flight at once can arrive.
//
// Usage: tsx tests/scripts/probe-tail-frame-latency.ts [changes]
// Environment: CHROME_BINARY (required), PROBE_NO_SANDBOX=1 for root in a
// container, PROBE_PAIR=1 for the pair mode.

const QUIET_MS = 400
const PAIR = process.env.PROBE_PAIR === '1'
const FRAME_TIMEOUT_MS = 2_000
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
] as const

type Rgb = readonly [number, number, number]

interface ArrivedFrame {
  readonly at: number
  readonly colour: Rgb
}

// The first pixel of a PNG's first row is stored unchanged by every filter
// type, so it can be read without unfiltering the image.
const firstPixel = (png: Buffer): Rgb => {
  let offset = 8
  let colourType = 2
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      colourType = body.readUInt8(9)
    } else if (type === 'IDAT') {
      data.push(body)
    }
    offset += length + 12
  }
  if (colourType !== 2 && colourType !== 6) {
    throw new Error(`Unexpected PNG colour type ${colourType.toString()}`)
  }
  const pixels = inflateSync(Buffer.concat(data))
  return [pixels.readUInt8(1), pixels.readUInt8(2), pixels.readUInt8(3)]
}

const sameColour = (left: Rgb, right: Rgb): boolean =>
  left.every((channel, index) => Math.abs(channel - (right[index] ?? -1)) <= 2)

// Neighbouring colours always differ in every channel.
const colourAt = (index: number): Rgb => [
  (index * 67 + 30) % 256,
  (index * 131 + 90) % 256,
  (index * 29 + 150) % 256,
]

const percentile = (sorted: readonly number[], fraction: number): number => {
  const rank = Math.ceil(fraction * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? Number.NaN
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

class FrameWatcher {
  private readonly frames: ArrivedFrame[] = []
  private waiter: { colour: Rgb; resolve: (at: number) => void } | undefined

  constructor(session: CDPSession) {
    session.on('Page.screencastFrame', (event) => {
      const at = Date.now()
      void session
        .send('Page.screencastFrameAck', { sessionId: event.sessionId })
        .catch(() => undefined)
      const colour = firstPixel(Buffer.from(event.data, 'base64'))
      this.frames.push({ at, colour })
      if (this.waiter && sameColour(colour, this.waiter.colour)) {
        this.waiter.resolve(at)
        this.waiter = undefined
      }
    })
  }

  get count(): number {
    return this.frames.length
  }

  // When the first frame showing `colour` arrived after `since`, if one did.
  arrivedSince(since: number, colour: Rgb): number | undefined {
    return this.frames.find(
      (frame) => frame.at >= since && sameColour(frame.colour, colour),
    )?.at
  }

  // Resolves with the arrival time of the first frame showing `colour`, or
  // undefined when none arrives in time.
  async arrivalOf(colour: Rgb): Promise<number | undefined> {
    const { promise, resolve } = Promise.withResolvers<number | undefined>()
    this.waiter = { colour, resolve }
    const timer = setTimeout(() => {
      resolve(undefined)
    }, FRAME_TIMEOUT_MS)
    try {
      return await promise
    } finally {
      clearTimeout(timer)
      this.waiter = undefined
    }
  }
}

const measureViewport = async (
  executablePath: string,
  viewport: (typeof VIEWPORTS)[number],
  changes: number,
): Promise<number[]> => {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--window-size=${viewport.width.toString()},${viewport.height.toString()}`,
      ...(process.env.PROBE_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport(viewport)
    await page.setContent(
      '<html><body style="margin:0;background:rgb(0,0,0)"></body></html>',
    )
    const session = await page.createCDPSession()
    const watcher = new FrameWatcher(session)
    await session.send('Page.startScreencast', { format: 'png' })
    const latencies: number[] = []
    const pageClock: number[] = []
    let pairsMerged = 0
    for (let index = 1; index <= changes; index += 1) {
      await sleep(QUIET_MS)
      const colour = colourAt(index)
      const arrival = watcher.arrivalOf(colour)
      // The page's clock can run a few milliseconds off Node's, so the delay
      // is also measured on Node's clock from when the change was requested,
      // which bounds it from above by the request's one-way trip.
      const requestedAt = Date.now()
      const first = colourAt(index + 1_000)
      const changedAt = await page.evaluate(
        (css: string, before: string | undefined) => {
          const view = globalThis as unknown as {
            document: { body: { style: { background: string } } }
            requestAnimationFrame: (callback: () => void) => void
          }
          const { body } = view.document
          if (before === undefined) {
            body.style.background = css
          } else {
            // Two paints one animation frame apart.
            body.style.background = before
            view.requestAnimationFrame(() => {
              view.requestAnimationFrame(() => {
                body.style.background = css
              })
            })
          }
          return Date.now()
        },
        `rgb(${colour.join(',')})`,
        PAIR ? `rgb(${first.join(',')})` : undefined,
      )
      const arrivedAt = await arrival
      if (arrivedAt === undefined) {
        console.log(`change ${index.toString()}: no frame within timeout`)
      } else if (PAIR) {
        const firstAt = watcher.arrivedSince(requestedAt, first)
        if (firstAt === undefined) {
          pairsMerged += 1
        } else {
          latencies.push(arrivedAt - firstAt)
        }
      } else {
        latencies.push(arrivedAt - requestedAt)
        pageClock.push(arrivedAt - changedAt)
      }
    }
    await session.send('Page.stopScreencast')
    console.log(`frames received: ${watcher.count.toString()}`)
    if (PAIR) {
      console.log(
        `pairs whose first paint had no frame: ${pairsMerged.toString()}`,
      )
    }
    console.log(`measured on the page's clock: ${JSON.stringify(pageClock)}`)
    return latencies
  } finally {
    await browser.close()
  }
}

const main = async (): Promise<void> => {
  const executablePath = process.env.CHROME_BINARY
  if (!executablePath) {
    throw new Error('Set CHROME_BINARY to the Chrome executable to probe.')
  }
  const changes = Number.parseInt(process.argv[2] ?? '60', 10)
  for (const viewport of VIEWPORTS) {
    const latencies = await measureViewport(executablePath, viewport, changes)
    const sorted = latencies.toSorted((left, right) => left - right)
    const label = `${viewport.width.toString()}x${viewport.height.toString()}`
    console.log(
      JSON.stringify({
        viewport: label,
        samples: sorted.length,
        missed: changes - sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1),
        latencies,
      }),
    )
  }
}

await main()
