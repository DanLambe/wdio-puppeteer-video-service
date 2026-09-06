import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import { assertManifestMediaDimensions } from '../utils/manifest-media-assertions.js'
import { assertOfflineReportInBrowser } from '../utils/offline-report-browser.js'
import { assertStaticVideoReport } from '../utils/video-artifact-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

type AdvancedMode =
  | 'retry'
  | 'spec-file-retry'
  | 'spec-level'
  | 'no-segment'
  | 'test-full-style'
  | 'session-style'
  | 'session-full-style'
  | 'deferred-merge'
  | 'include-spec'
  | 'exclude-spec'
  | 'include-tag'
  | 'exclude-tag'
  | 'retention'
  | 'global-concurrency'
  | 'ffmpeg-failure'

const assertDiscardedRetentionEntry = async (
  resultsDir: string,
): Promise<void> => {
  const manifestValue: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  if (!isVideoManifest(manifestValue)) {
    throw new TypeError(
      '[e2e:advanced] retention mode produced an invalid manifest',
    )
  }
  const discardedEntry = manifestValue.runs
    .flatMap((run) => run.entries)
    .find((entry) => entry.test?.name === 'should discard a passing recording')
  if (
    discardedEntry?.capture.decision !== 'discarded' ||
    discardedEntry.capture.segments.length !== 0 ||
    discardedEntry.capture.final !== undefined ||
    discardedEntry.processing.outcome !== 'skipped'
  ) {
    throw new Error(
      '[e2e:advanced] passing retention entry should be discarded without published media or post-processing',
    )
  }
}

const requestedMode = process.argv[2] || 'all'

const resolveModeOrder = (mode: string): AdvancedMode[] => {
  if (mode === 'windows') {
    return [
      'deferred-merge',
      'global-concurrency',
      'ffmpeg-failure',
      'retention',
    ]
  }
  if (mode === 'all') {
    return [
      'retry',
      'spec-file-retry',
      'spec-level',
      'no-segment',
      'test-full-style',
      'session-style',
      'session-full-style',
      'deferred-merge',
      'include-spec',
      'exclude-spec',
      'include-tag',
      'exclude-tag',
      'retention',
      'global-concurrency',
      'ffmpeg-failure',
    ]
  }

  if (
    mode === 'retry' ||
    mode === 'spec-file-retry' ||
    mode === 'spec-level' ||
    mode === 'no-segment' ||
    mode === 'test-full-style' ||
    mode === 'session-style' ||
    mode === 'session-full-style' ||
    mode === 'deferred-merge' ||
    mode === 'include-spec' ||
    mode === 'exclude-spec' ||
    mode === 'include-tag' ||
    mode === 'exclude-tag' ||
    mode === 'retention' ||
    mode === 'global-concurrency' ||
    mode === 'ffmpeg-failure'
  ) {
    return [mode]
  }

  return []
}

const modeOrder = resolveModeOrder(requestedMode)
if (modeOrder.length === 0) {
  console.error(
    `[e2e:advanced] Invalid mode "${requestedMode}". Use all, windows, retry, spec-file-retry, spec-level, no-segment, test-full-style, session-style, session-full-style, deferred-merge, include-spec, exclude-spec, include-tag, exclude-tag, retention, global-concurrency, or ffmpeg-failure.`,
  )
  process.exit(1)
}

const runMode = async (
  mode: AdvancedMode,
  environment: E2eEnvironment,
): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', `advanced-${mode}`)
  const isTagFilterMode = mode === 'include-tag' || mode === 'exclude-tag'
  const configPath = path.resolve(
    isTagFilterMode
      ? 'tests/wdio.cucumber.conf.ts'
      : 'tests/wdio.advanced.conf.ts',
  )

  console.log(`[e2e:advanced] Starting ${mode} run. Artifacts => ${resultsDir}`)

  const child = spawn(nodeCommand, [wdioCliPath, 'run', configPath], {
    stdio: 'inherit',
    windowsHide: true,
    env: environment.childEnvironment({
      WDIO_ADVANCED_MODE: mode,
      WDIO_RESULTS_DIR: resultsDir,
      ...(isTagFilterMode ? { WDIO_CUCUMBER_FILTER_MODE: mode } : {}),
    }),
  })

  await waitForChildProcess(
    child,
    (code) => `[e2e:advanced] ${mode} run failed with code ${code}`,
    5 * 60_000,
    mode === 'retention' ? [1] : [0],
  )

  if (mode === 'retention') {
    await assertDiscardedRetentionEntry(resultsDir)
  }
  if (mode === 'retry' || mode === 'deferred-merge') {
    await assertManifestMediaDimensions(
      resultsDir,
      environment.ffmpegDetection.resolvedPath,
    )
  }

  if (mode === 'global-concurrency') {
    // Config onComplete runs before launcher services, so verify final cleanup here.
    const remainingRuns = await readdir(
      path.join(resultsDir, '.global-recording-locks'),
    )
    if (remainingRuns.length > 0) {
      throw new Error(
        `[e2e:advanced] launcher left global slot run directories: ${remainingRuns.join(', ')}`,
      )
    }
  }

  const retryTitle =
    mode === 'retry'
      ? 'should record only when retry attempt executes'
      : 'should record only when spec file retry worker executes'
  if (mode === 'retry' || mode === 'spec-file-retry') {
    await assertStaticVideoReport({
      resultsDir,
      expectedTitles: [retryTitle],
      expectRetryOutcomes: true,
      runLabel: `advanced-${mode}`,
    })
  }

  if (mode === 'deferred-merge') {
    await assertStaticVideoReport({
      resultsDir,
      expectedTitles: [
        'should produce a deferred merged artifact for a multi-window flow',
        'should process an independent deferred merge within the worker limit',
      ],
      expectRetryOutcomes: false,
      runLabel: 'advanced-deferred-merge',
    })
  }

  if (mode === 'retry') {
    await assertOfflineReportInBrowser(resultsDir)
  }

  if (mode === 'retry' || mode === 'spec-file-retry' || mode === 'retention') {
    await assertAllureVideoAttachments({
      resultsDir,
      expectedTitles: [
        mode === 'retention'
          ? 'should retain an intentionally failed recording'
          : retryTitle,
      ],
      runLabel: `advanced-${mode}-allure`,
    })
  }

  console.log(`[e2e:advanced] Completed ${mode} run.`)
}

const environment = await startE2eEnvironment()
try {
  for (const mode of modeOrder) {
    await runMode(mode, environment)
  }
} finally {
  await environment.close()
}

console.log('[e2e:advanced] All requested advanced runs completed.')
