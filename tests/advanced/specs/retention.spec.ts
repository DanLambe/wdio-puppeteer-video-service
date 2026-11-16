import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { runWindowSwitchingJourney } from './window-switch-journey.js'

const resultsDir = path.resolve(process.env.WDIO_RESULTS_DIR ?? '')
// Under `retain: 'failures'`, 'auto' spools as 'deferred' does.
const spooling = ['auto', 'deferred'].includes(
  process.env.WDIO_CAPTURE_ENCODING ?? '',
)

const listSpools = async (): Promise<string[]> =>
  (
    await readdir(path.join(resultsDir, '.wdio-video-spool'), {
      recursive: true,
    }).catch((): string[] => [])
  ).filter((name) => /_part\d+\.[^.]+\.mkv$/u.test(name))

// A tab move stops a segment without processing it: until the test ends,
// every part is still the WebM the encoder wrote, or the spool its frames
// went to, and none is transcoded.
const expectUnprocessedSegments = async (stoppedSegments: number) => {
  const parts = (await readdir(resultsDir)).filter((name) =>
    /_part\d+\.(mp4|webm)$/u.test(name),
  )
  expect(parts.filter((name) => name.endsWith('.mp4'))).toEqual([])
  expect(parts.filter((name) => name.endsWith('.webm'))).toHaveLength(
    spooling ? 0 : stoppedSegments + 1,
  )
  expect(await listSpools()).toHaveLength(spooling ? stoppedSegments + 1 : 0)
}

describe('Advanced E2E - Retention', () => {
  it('should discard a passing recording', async () => {
    await runWindowSwitchingJourney({
      afterTabMove: expectUnprocessedSegments,
    })
  })

  it('should retain an intentionally failed recording', async () => {
    await runWindowSwitchingJourney({
      afterTabMove: expectUnprocessedSegments,
    })

    await expect($('h3')).toHaveText(
      'This assertion intentionally fails to characterize failure retention.',
    )
  })
})
