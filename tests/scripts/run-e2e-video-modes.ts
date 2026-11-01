import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest, type ManifestEntryV1 } from '../../src/manifest.js'
import { readFfmpegVersion } from '../../src/service/ffmpeg.js'
import { resolveTimestampPassthroughArgs } from '../../src/service/post-process.js'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import {
  decodeColorTimeline,
  type SolidColor,
} from '../utils/media-timeline.js'
import {
  dominantColor,
  firstColor,
  orderSegments,
} from '../utils/segment-colors.js'
import {
  findTabProvenanceProblems,
  readEntryTabs,
  type TabStep,
  toTabSteps,
} from '../utils/tab-provenance.js'
import { assertStaticVideoReport } from '../utils/video-artifact-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

// `merge-kept` merges but keeps the original segments beside the merged file.
type VideoMode = 'multipart' | 'merge' | 'merge-kept'
type Protocol = 'bidi' | 'classic'

const expectedTestTitles = [
  'should record a simple navigation',
  'should handle iframe switching',
  'should handle a cross-origin iframe',
  'should handle multiple tabs and closing tabs',
  'should tolerate a browser target closing itself',
  'should handle alert, confirm, and prompt dialogs',
  'should handle viewport resizing',
  'should capture a deterministic animation',
  'should record a longer multi-step journey',
]

// WebDriver BiDi tests that drive held tabs; each tab paints one color. The
// first test's red tab turns green when clicked right after recording returns
// to it, so the return segment must open on red.
const tabFollowingSegments: ReadonlyArray<
  readonly [string, readonly SegmentExpectation[]]
> = [
  [
    'should follow a held new window',
    [
      { dominant: 'red', tab: [1, 'start'] },
      { dominant: 'blue', tab: [2, 'command'] },
      { dominant: 'green', first: 'red', tab: [1, 'command'] },
    ],
  ],
  [
    'should follow a tab the page opens',
    [
      { dominant: 'red', tab: [1, 'start'] },
      { dominant: 'green', tab: [2, 'command'] },
      { dominant: 'red', tab: [1, 'tab-closed'] },
    ],
  ],
  [
    'should follow a background command on a held tab',
    [
      { dominant: 'red', tab: [1, 'start'] },
      { dominant: 'blue', tab: [2, 'command'] },
      { dominant: 'red', tab: [1, 'command'] },
      { dominant: 'blue', tab: [2, 'command'] },
      { dominant: 'red', tab: [1, 'command'] },
    ],
  ],
  [
    'should return to its window when a switch to a closed one is rejected',
    [
      { dominant: 'red', tab: [1, 'start'] },
      { dominant: 'blue', tab: [2, 'command'] },
      { dominant: 'red', tab: [1, 'switch-to-window'] },
      { dominant: 'red', tab: [1, 'switch-failed'] },
    ],
  ],
]

const requestedMode = process.argv[2] || 'both'

let modeOrder: VideoMode[]
if (requestedMode === 'both') {
  modeOrder = ['multipart', 'merge']
} else if (
  requestedMode === 'multipart' ||
  requestedMode === 'merge' ||
  requestedMode === 'merge-kept'
) {
  modeOrder = [requestedMode]
} else {
  modeOrder = []
}

if (modeOrder.length === 0) {
  console.error(
    `[e2e:modes] Invalid mode "${requestedMode}". Use multipart, merge, merge-kept, or both.`,
  )
  process.exit(1)
}

// WebDriver BiDi by default; `classic` runs the window- and frame-switching
// suite under 'wdio:enforceWebDriverClassic'.
const requestedProtocol = process.argv[3] || 'bidi'
if (requestedProtocol !== 'bidi' && requestedProtocol !== 'classic') {
  console.error(
    `[e2e:modes] Invalid protocol "${requestedProtocol}". Use bidi or classic.`,
  )
  process.exit(1)
}
const protocol: Protocol = requestedProtocol
const requestedBrowser = process.argv[4] || 'chrome'
if (requestedBrowser !== 'chrome' && requestedBrowser !== 'edge') {
  console.error(
    `[e2e:modes] Invalid browser "${requestedBrowser}". Use chrome or edge.`,
  )
  process.exit(1)
}
const browserName = requestedBrowser
const runTitles =
  protocol === 'bidi'
    ? [...expectedTestTitles, ...tabFollowingSegments.map(([title]) => title)]
    : expectedTestTitles

interface SegmentExpectation {
  /** The tab's color, shown for most of the segment. */
  readonly dominant: SolidColor
  /** The first frame, when an action right after the switch must be filmed. */
  readonly first?: SolidColor
  /** The manifest's tab for the segment. */
  readonly tab: TabStep
}

const assertTabFollowing = async (
  entries: readonly ManifestEntryV1[],
  resultsDir: string,
  ffmpegPath: string,
): Promise<void> => {
  const passthrough = resolveTimestampPassthroughArgs(
    await readFfmpegVersion(ffmpegPath),
  )
  for (const [title, expected] of tabFollowingSegments) {
    const entry = entries.find((candidate) => candidate.test?.name === title)
    // A tab the recorder could not film would make the recording incomplete.
    assert.equal(
      entry?.capture.decision,
      'recorded',
      `Expected "${title}" to be recorded without a gap`,
    )
    const parts = (entry?.capture.segments ?? []).filter(
      (segment) => segment.tab,
    )
    const actual = orderSegments(parts).map((segment, index) => {
      const spans = decodeColorTimeline(
        ffmpegPath,
        path.join(resultsDir, segment.path),
        30,
        passthrough,
      ).spans
      const [tab] = toTabSteps([segment.tab])
      return {
        dominant: dominantColor(spans),
        ...(expected[index]?.first ? { first: firstColor(spans) } : {}),
        tab,
      }
    })
    assert.deepEqual(
      actual,
      expected,
      `Expected the tab each segment of "${title}" drove`,
    )
  }
}

/** A merged file kept beside its parts shows each tab's color in order. */
const assertKeptMerge = async (
  entries: readonly ManifestEntryV1[],
  resultsDir: string,
  ffmpegPath: string,
): Promise<void> => {
  const passthrough = resolveTimestampPassthroughArgs(
    await readFfmpegVersion(ffmpegPath),
  )
  for (const [title, expected] of tabFollowingSegments) {
    const entry = entries.find((candidate) => candidate.test?.name === title)
    const merged = entry?.capture.segments.find((segment) => segment.tabs)
    assert.ok(merged, `Expected "${title}" to keep a merged file`)
    assert.equal(entry?.capture.final, undefined)
    // Brief spans are switch transitions, and consecutive parts on one tab
    // play as one span.
    const colors = decodeColorTimeline(
      ffmpegPath,
      path.join(resultsDir, merged.path),
      30,
      passthrough,
    )
      .spans.filter((span) => span.end - span.start > 0.6)
      .map((span) => span.color)
    const expectedColors = expected
      .map((segment) => segment.dominant)
      .filter((color, index, all) => color !== all[index - 1])
    assert.deepEqual(
      colors,
      expectedColors,
      `Expected the merged video of "${title}" to play its tabs in order`,
    )
  }
}

const assertTabProvenance = (
  entries: readonly ManifestEntryV1[],
  mode: VideoMode,
): void => {
  assert.deepEqual(entries.flatMap(findTabProvenanceProblems), [])
  if (protocol !== 'bidi' || mode === 'multipart') {
    return
  }
  // A merged video lists the tabs of its parts in order.
  for (const [title, expected] of tabFollowingSegments) {
    const entry = entries.find((candidate) => candidate.test?.name === title)
    assert.deepEqual(
      entry ? toTabSteps(readEntryTabs(entry)) : [],
      expected.map((segment) => segment.tab),
      `Expected the merged tabs of "${title}"`,
    )
  }
}

const assertReportTabLabels = async (
  resultsDir: string,
  mode: VideoMode,
): Promise<void> => {
  if (protocol !== 'bidi') {
    return
  }
  const report = await readFile(
    path.join(resultsDir, 'video-report.html'),
    'utf8',
  )
  const labels = {
    multipart: ['Tab 2 · test command'],
    merge: ['Tabs 1 → 2 → 1'],
    'merge-kept': ['Tab 2 · test command', 'Tabs 1 → 2 → 1'],
  }[mode]
  for (const label of labels) {
    assert.ok(
      report.includes(`<span class="tab-label">${label}</span>`),
      `Expected the report to label tabs with "${label}"`,
    )
  }
}

const runWdio = async (
  mode: VideoMode,
  environment: E2eEnvironment,
): Promise<void> => {
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const label = [
    mode,
    ...(protocol === 'bidi' ? [] : [protocol]),
    ...(browserName === 'chrome' ? [] : [browserName]),
  ].join('-')
  const resultsDir = path.resolve('tests/results', label)
  const mergeEnabled = mode === 'multipart' ? '0' : '1'

  console.log(`[e2e:modes] Starting ${label} run. Artifacts => ${resultsDir}`)

  const child = spawn(nodeCommand, [wdioCliPath, 'run', 'tests/wdio.conf.ts'], {
    stdio: 'inherit',
    windowsHide: true,
    env: environment.childEnvironment({
      WDIO_MERGE_SEGMENTS: mergeEnabled,
      WDIO_MERGE_KEEP_SEGMENTS: mode === 'merge-kept' ? '1' : '0',
      WDIO_PROTOCOL: protocol,
      WDIO_BROWSER: browserName,
      WDIO_VIDEO_MODE: label,
      WDIO_RESULTS_DIR: resultsDir,
    }),
  })

  await waitForChildProcess(child, (code) => {
    return `[e2e:modes] ${label} run failed with code ${code}`
  })
  const manifest: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  assert.ok(isVideoManifest(manifest))
  assertTabProvenance(
    manifest.runs.flatMap((run) => run.entries),
    mode,
  )
  const ffmpegPath = environment.ffmpegDetection.resolvedPath
  if (mode !== 'merge' && protocol === 'bidi' && ffmpegPath) {
    const entries = manifest.runs.flatMap((run) => run.entries)
    // Kept parts decode like multipart ones.
    await assertTabFollowing(entries, resultsDir, ffmpegPath)
    if (mode === 'merge-kept') {
      await assertKeptMerge(entries, resultsDir, ffmpegPath)
    }
  }
  if (mode === 'multipart') {
    const frameEntry = manifest.runs
      .flatMap((run) => run.entries)
      .find(
        (entry) => entry.test?.name === 'should handle a cross-origin iframe',
      )
    assert.ok(
      frameEntry && frameEntry.capture.segments.length >= 2,
      'Expected iframe-to-window recording segments without page-lookup skips',
    )
    for (const title of [
      'should handle multiple tabs and closing tabs',
      'should tolerate a browser target closing itself',
    ]) {
      const windowEntry: ManifestEntryV1 | undefined = manifest.runs
        .flatMap((run) => run.entries)
        .find((entry) => entry.test?.name === title)
      assert.equal(
        windowEntry?.capture.segments.length,
        3,
        `Expected original, new-tab and returned-tab segments for ${title}`,
      )
    }
  }
  await assertStaticVideoReport({
    resultsDir,
    expectedTitles: runTitles,
    runLabel: label,
  })
  await assertReportTabLabels(resultsDir, mode)
  await assertAllureVideoAttachments({
    resultsDir,
    expectedTitles: runTitles,
    runLabel: `${label}-allure`,
  })

  console.log(`[e2e:modes] Completed ${label} run.`)
}

const environment = await startE2eEnvironment()
try {
  for (const mode of modeOrder) {
    // Sequential runs preserve distinct artifact folders for each mode.
    await runWdio(mode, environment)
  }
} finally {
  await environment.close()
}

console.log('[e2e:modes] All requested runs completed successfully.')
