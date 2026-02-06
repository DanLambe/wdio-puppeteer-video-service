import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoService from '../src/index.js'

const mergeSegmentsEnabled = ['1', 'true', 'yes'].includes(
  (process.env.WDIO_MERGE_SEGMENTS ?? '').toLowerCase(),
)
const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
const runMode =
  process.env.WDIO_VIDEO_MODE || (mergeSegmentsEnabled ? 'merge' : 'multipart')
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR || path.join('tests/results', runMode),
)
const expectedTestTitles = [
  'should record a simple navigation',
  'should handle iframe switching',
  'should handle multiple tabs and closing tabs',
  'should handle javascript alerts',
  'should handle viewport resizing',
  'should record a longer multi-step journey',
]

const toFileToken = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const config: WebdriverIO.Config = {
  //
  // ====================
  // Runner Configuration
  // ====================
  runner: 'local',
  tsConfigPath: './tsconfig.spec.json',
  //
  // ==================
  // Specify Test Files
  // ==================
  specs: ['./specs/**/*.test.ts'],
  // Patterns to exclude.
  exclude: [],
  //
  // ============
  // Capabilities
  // ============
  maxInstances: 3,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: [
          '--headless=new',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--window-size=1280,720',
        ],
      },
    },
  ],
  //
  // ===================
  // Test Configurations
  // ===================
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [
    [
      WdioPuppeteerVideoService,
      {
        outputDir: resultsDir,
        saveAllVideos: true,
        videoWidth: 1280,
        videoHeight: 720,
        outputFormat: 'mp4',
        transcode: {
          enabled: true,
        },
        mergeSegments: {
          enabled: mergeSegmentsEnabled,
          deleteSegments: true,
        },
      },
    ],
  ],
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  onPrepare: async () => {
    await emptyDir(resultsDir)
  },
  onComplete: async () => {
    const files = await readdir(resultsDir).catch(() => [])
    const mediaFiles = files.filter(
      (file) => file.endsWith('.mp4') || file.endsWith('.webm'),
    )

    if (mediaFiles.length === 0) {
      if (!expectVideos) {
        console.warn(
          `[wdio:e2e] No video files were generated in ${resultsDir}. Skipping artifact assertions because WDIO_EXPECT_VIDEOS=${process.env.WDIO_EXPECT_VIDEOS ?? '0'}.`,
        )
        return
      }
      throw new Error(`No video files were generated in ${resultsDir}`)
    }

    for (const file of mediaFiles) {
      const filePath = path.join(resultsDir, file)
      const fileSize = await stat(filePath)
        .then((stats) => stats.size)
        .catch(() => 0)
      if (fileSize < 1_024) {
        console.warn(
          `[wdio:e2e] Video file ${file} is very small (${fileSize} bytes)`,
        )
      }
    }

    const missingTitles: string[] = []
    for (const title of expectedTestTitles) {
      const slug = toFileToken(title)
      const pattern = mergeSegmentsEnabled
        ? new RegExp(
            `^${escapeRegExp(slug)}_[a-z0-9]{1,12}_[a-f0-9]{8}(?:_retry\\d+)?\\.(mp4|webm)$`,
          )
        : new RegExp(
            `^${escapeRegExp(slug)}_[a-z0-9]{1,12}_[a-f0-9]{8}(?:_retry\\d+)?_part\\d+\\.(mp4|webm)$`,
          )
      const hasArtifact = mediaFiles.some((file) => pattern.test(file))
      if (!hasArtifact) {
        missingTitles.push(title)
      }
    }

    if (missingTitles.length > 0) {
      throw new Error(
        `Missing video artifacts for tests: ${missingTitles.join(', ')}`,
      )
    }

    if (mergeSegmentsEnabled) {
      const partArtifacts = mediaFiles.filter((file) => /_part\d+\./.test(file))
      if (partArtifacts.length > 0) {
        throw new Error(
          `Expected merged artifacts only, but found segment parts: ${partArtifacts.join(', ')}`,
        )
      }
    }

    console.log(
      `[wdio:e2e] Verified ${mediaFiles.length} video artifacts across parallel spec files (mode=${runMode}, merge=${mergeSegmentsEnabled}, expectVideos=${expectVideos}, dir=${resultsDir}).`,
    )
  },
}
