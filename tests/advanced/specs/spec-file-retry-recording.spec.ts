import fs from 'node:fs/promises'
import path from 'node:path'

const retryMarkerPath = path.resolve(
  process.env.WDIO_RESULTS_DIR ||
    path.join('tests', 'results', 'advanced-spec-file-retry'),
  '.spec-file-retry-marker',
)

describe('Advanced E2E - Spec File Retry Recording', () => {
  it('should record only when spec file retry worker executes', async () => {
    await browser.url('https://the-internet.herokuapp.com/')
    await expect(browser).toHaveTitle('The Internet')
    await browser.pause(1200)

    const markerExists = await fs
      .access(retryMarkerPath)
      .then(() => true)
      .catch(() => false)
    if (markerExists) {
      return
    }

    await fs.mkdir(path.dirname(retryMarkerPath), { recursive: true })
    await fs.writeFile(retryMarkerPath, 'first-worker-attempt', 'utf8')
    throw new Error(
      'Intentional first-worker failure to verify specFileRetries retry-only recording',
    )
  })
})
