import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import {
  assertSpoolDirectoryRemoved,
  captureEncodingSuffix,
} from '../utils/capture-encoding.js'
import { assertManifestMediaDimensions } from '../utils/manifest-media-assertions.js'
import { assertOfflineReportInBrowser } from '../utils/offline-report-browser.js'
import {
  findTabProvenanceProblems,
  readEntryTabs,
  toTabSteps,
} from '../utils/tab-provenance.js'
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
  | 'failure-burst'

// Each test moves tab twice: part 1 on the first tab, part 2 on the second,
// part 3 back on the first.
const RETAINED_TAB_STEPS = JSON.stringify([
  [1, 'start'],
  [2, 'switch-to-window'],
  [1, 'switch-to-window'],
])

const assertRetentionEntries = async (resultsDir: string): Promise<void> => {
  const manifestValue: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  if (!isVideoManifest(manifestValue)) {
    throw new TypeError(
      '[e2e:advanced] retention mode produced an invalid manifest',
    )
  }
  const entries = manifestValue.runs.flatMap((run) => run.entries)
  const discardedEntry = entries.find(
    (entry) => entry.test?.name === 'should discard a passing recording',
  )
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

  // A kept multi-tab recording lists each transcoded part with its tab, as
  // when every segment was transcoded at its tab move.
  const retainedEntry = entries.find(
    (entry) =>
      entry.test?.name === 'should retain an intentionally failed recording',
  )
  const segments = retainedEntry?.capture.segments ?? []
  const parts = segments.map((segment) =>
    /_part(\d+)\.mp4$/u.exec(segment.path),
  )
  if (
    retainedEntry?.capture.decision !== 'recorded' ||
    retainedEntry.processing.outcome !== 'completed' ||
    retainedEntry.processing.operation !== 'transcode' ||
    parts.map((part) => part?.[1]).join() !== '1,2,3' ||
    segments.some((segment) => segment.mimeType !== 'video/mp4') ||
    JSON.stringify(toTabSteps(readEntryTabs(retainedEntry))) !==
      RETAINED_TAB_STEPS ||
    findTabProvenanceProblems(retainedEntry).length > 0
  ) {
    throw new Error(
      `[e2e:advanced] failing retention entry should keep three transcoded parts with their tabs, got ${JSON.stringify(retainedEntry?.capture)}`,
    )
  }
}

// Every failing worker's recording is kept whole: three WebM parts with their
// tabs, recorded, and never left as frames.
const assertFailureBurstEntries = async (resultsDir: string): Promise<void> => {
  const manifestValue: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  if (!isVideoManifest(manifestValue)) {
    throw new TypeError(
      '[e2e:advanced] failure-burst mode produced an invalid manifest',
    )
  }
  const entries = manifestValue.runs.flatMap((run) => run.entries)
  if (entries.length !== 3) {
    throw new Error(
      `[e2e:advanced] failure-burst mode expected three entries, got ${entries.length.toString()}`,
    )
  }
  for (const entry of entries) {
    const parts = entry.capture.segments.map(
      (segment) => /_part(\d+)\.webm$/u.exec(segment.path)?.[1],
    )
    if (
      entry.capture.decision !== 'recorded' ||
      entry.result !== 'failed' ||
      parts.join() !== '1,2,3' ||
      JSON.stringify(toTabSteps(readEntryTabs(entry))) !== RETAINED_TAB_STEPS ||
      findTabProvenanceProblems(entry).length > 0
    ) {
      throw new Error(
        `[e2e:advanced] failure-burst entry should keep three WebM parts with their tabs, got ${JSON.stringify(entry.capture)}`,
      )
    }
  }
  if (['auto', 'deferred'].includes(process.env.WDIO_CAPTURE_ENCODING ?? '')) {
    await assertEncodesOneAtATime(
      resultsDir,
      entries.flatMap((entry) =>
        entry.capture.segments.map(({ path }) => path),
      ),
    )
  }
}

/**
 * A spooled part's file is created when its encode reserves it and last
 * written when FFmpeg finishes, so with one post-processing slot no two of
 * those spans overlap, across workers. Skipped where the file system keeps no
 * creation time.
 */
const assertEncodesOneAtATime = async (
  resultsDir: string,
  paths: readonly string[],
): Promise<void> => {
  const spans = (
    await Promise.all(
      paths.map(async (segmentPath) => {
        const stats = await stat(path.join(resultsDir, segmentPath))
        return {
          end: stats.mtimeMs,
          path: segmentPath,
          start: stats.birthtimeMs,
        }
      }),
    )
  ).sort((left, right) => left.start - right.start)
  if (spans.some((span) => span.start <= 0)) {
    console.log(
      '[e2e:advanced] failure-burst: no file creation times; encode order not checked.',
    )
    return
  }
  for (const [index, span] of spans.entries()) {
    const previous = spans[index - 1]
    if (previous && span.start < previous.end) {
      throw new Error(
        `[e2e:advanced] failure-burst encodes overlapped: ${span.path} was reserved before ${previous.path} was written`,
      )
    }
  }
  console.log(
    `[e2e:advanced] failure-burst: ${spans.length.toString()} encodes ran one at a time.`,
  )
}

const requestedMode = process.argv[2] || 'all'

const resolveModeOrder = (mode: string): AdvancedMode[] => {
  if (mode === 'windows') {
    return [
      'deferred-merge',
      'global-concurrency',
      'ffmpeg-failure',
      'retention',
      'failure-burst',
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
      'failure-burst',
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
    mode === 'ffmpeg-failure' ||
    mode === 'failure-burst'
  ) {
    return [mode]
  }

  return []
}

const modeOrder = resolveModeOrder(requestedMode)
if (modeOrder.length === 0) {
  console.error(
    `[e2e:advanced] Invalid mode "${requestedMode}". Use all, windows, retry, spec-file-retry, spec-level, no-segment, test-full-style, session-style, session-full-style, deferred-merge, include-spec, exclude-spec, include-tag, exclude-tag, retention, global-concurrency, ffmpeg-failure, or failure-burst. Set WDIO_CAPTURE_ENCODING to live, auto or deferred to choose capture.encoding.`,
  )
  process.exit(1)
}

const runMode = async (
  mode: AdvancedMode,
  environment: E2eEnvironment,
): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve(
    'tests/results',
    `advanced-${mode}${captureEncodingSuffix()}`,
  )
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
    mode === 'retention' || mode === 'failure-burst' ? [1] : [0],
  )
  await assertSpoolDirectoryRemoved(resultsDir)

  if (mode === 'retention') {
    await assertRetentionEntries(resultsDir)
  }
  if (mode === 'failure-burst') {
    await assertFailureBurstEntries(resultsDir)
  }
  if (
    mode === 'retry' ||
    mode === 'deferred-merge' ||
    mode === 'retention' ||
    mode === 'failure-burst'
  ) {
    await assertManifestMediaDimensions(
      resultsDir,
      environment.ffmpegDetection.resolvedPath,
    )
  }

  if (mode === 'global-concurrency' || mode === 'failure-burst') {
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
