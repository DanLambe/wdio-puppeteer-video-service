import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { runWindowSwitchingJourney } from './window-switch-journey.js'

const resultsDir = path.resolve(process.env.WDIO_RESULTS_DIR ?? '')

// A tab move stops a segment without processing it: until the test ends,
// every part is still the WebM the encoder wrote, and none is transcoded.
const expectUnprocessedSegments = async (stoppedSegments: number) => {
  const parts = (await readdir(resultsDir)).filter((name) =>
    /_part\d+\.(mp4|webm)$/u.test(name),
  )
  expect(parts.filter((name) => name.endsWith('.mp4'))).toEqual([])
  expect(parts.filter((name) => name.endsWith('.webm'))).toHaveLength(
    stoppedSegments + 1,
  )
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
