import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import { assertManifestMediaDimensions } from '../utils/manifest-media-assertions.js'
import {
  assertStaticVideoReport,
  listVideoArtifacts,
} from '../utils/video-artifact-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

type FrameworkMode =
  | 'jasmine'
  | 'cucumber'
  | 'cucumber-retry-all'
  | 'cucumber-retry-retries'
  | 'cucumber-duplicate-names'

const CUCUMBER_DUPLICATE_TITLES = [
  'cucumber style should record each same-named scenario',
  'cucumber style should record each outline row',
]

const CUCUMBER_RETRY_TITLE =
  'cucumber style should record the retried scenario attempt'
const RETRY_ARTIFACT_PATTERN = /_retry1(?:_part\d+)?\.mp4$/u

const requestedMode = process.argv[2] || 'both'

const resolveFrameworkOrder = (mode: string): FrameworkMode[] => {
  if (mode === 'both') {
    return ['jasmine', 'cucumber']
  }
  if (mode === 'cucumber-retry') {
    return ['cucumber-retry-all', 'cucumber-retry-retries']
  }
  if (
    mode === 'jasmine' ||
    mode === 'cucumber' ||
    mode === 'cucumber-retry-all' ||
    mode === 'cucumber-retry-retries' ||
    mode === 'cucumber-duplicate-names'
  ) {
    return [mode]
  }
  return []
}

/**
 * Distinct scenarios that share a title must each keep their own media, and
 * every step of a scenario must reference that scenario's recording.
 */
const assertDistinctScenarioMedia = async (
  resultsDir: string,
): Promise<void> => {
  const manifestValue: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  if (!isVideoManifest(manifestValue)) {
    throw new TypeError(
      `[e2e:frameworks] ${resultsDir} produced an invalid manifest`,
    )
  }

  const entries = manifestValue.runs
    .flatMap((run) => run.entries)
    .filter((entry) =>
      CUCUMBER_DUPLICATE_TITLES.includes(entry.test?.name ?? ''),
    )
  if (entries.length !== 4) {
    throw new Error(
      `[e2e:frameworks] Expected four same-named scenario captures, found ${entries.length.toString()}`,
    )
  }

  const manifestMedia = new Set(
    entries.flatMap((entry) => entry.capture.segments.map((item) => item.path)),
  )
  if (manifestMedia.size !== 4) {
    throw new Error(
      `[e2e:frameworks] Expected four distinct scenario recordings, found ${manifestMedia.size.toString()}`,
    )
  }

  const report = await readFile(
    path.join(resultsDir, 'video-report.html'),
    'utf8',
  )
  for (const mediaPath of manifestMedia) {
    if (!report.includes(`src="./${mediaPath}"`)) {
      throw new Error(
        `[e2e:frameworks] Static report never references ${mediaPath}`,
      )
    }
  }

  console.log(
    `[e2e:frameworks] Verified ${manifestMedia.size.toString()} same-named scenarios kept distinct media.`,
  )
}

/**
 * Cucumber never reports an attempt number of its own, so a retried scenario
 * must still resolve to attempts 1 and 2 with only the retry retained.
 */
const assertCucumberRetryAttempts = async (
  resultsDir: string,
  attempts: 'all' | 'retries',
): Promise<void> => {
  const manifestValue: unknown = JSON.parse(
    await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
  )
  if (!isVideoManifest(manifestValue)) {
    throw new TypeError(
      `[e2e:frameworks] ${resultsDir} produced an invalid manifest`,
    )
  }

  const entries = manifestValue.runs
    .flatMap((run) => run.entries)
    .filter((entry) => entry.test?.name === CUCUMBER_RETRY_TITLE)
    .sort((left, right) => left.attempt - right.attempt)
  const observedAttempts = entries.map((entry) => entry.attempt)
  if (observedAttempts.join(',') !== '1,2') {
    throw new Error(
      `[e2e:frameworks] Expected Cucumber attempts 1 and 2, found ${observedAttempts.join(', ') || 'none'}`,
    )
  }

  const firstAttempt = entries[0]
  const retryAttempt = entries[1]
  const expectedFirstDecision = attempts === 'retries' ? 'skipped' : 'discarded'
  if (
    firstAttempt?.capture.decision !== expectedFirstDecision ||
    firstAttempt.result !== 'failed'
  ) {
    throw new Error(
      `[e2e:frameworks] Expected the first Cucumber attempt to fail and be ${expectedFirstDecision}, found ${String(firstAttempt?.capture.decision)}/${String(firstAttempt?.result)}`,
    )
  }
  if (
    retryAttempt?.capture.decision !== 'recorded' ||
    retryAttempt.result !== 'passed' ||
    retryAttempt.capture.segments.length === 0
  ) {
    throw new Error(
      '[e2e:frameworks] Expected the retried Cucumber attempt to be recorded, passed, and retained',
    )
  }

  const artifacts = await listVideoArtifacts(resultsDir)
  const retainedArtifact = artifacts[0]
  if (
    artifacts.length !== 1 ||
    !RETRY_ARTIFACT_PATTERN.test(retainedArtifact ?? '')
  ) {
    throw new Error(
      `[e2e:frameworks] Expected exactly one retained retry artifact, found: ${artifacts.join(', ') || 'none'}`,
    )
  }

  console.log(
    `[e2e:frameworks] Verified Cucumber attempts 1 and 2 with attempts=${attempts} (${retainedArtifact ?? ''}).`,
  )
}

const frameworkOrder: FrameworkMode[] = resolveFrameworkOrder(requestedMode)

if (frameworkOrder.length === 0) {
  console.error(
    `[e2e:frameworks] Invalid mode "${requestedMode}". Use jasmine, cucumber, cucumber-retry, cucumber-retry-all, cucumber-retry-retries, cucumber-duplicate-names, or both.`,
  )
  process.exit(1)
}

const frameworkConfigMap: Record<
  FrameworkMode,
  {
    configPath: string
    resultsDirName: string
    retryAttempts?: 'all' | 'retries'
    duplicateNames?: boolean
  }
> = {
  jasmine: {
    configPath: 'tests/wdio.jasmine.conf.ts',
    resultsDirName: 'jasmine',
  },
  cucumber: {
    configPath: 'tests/wdio.cucumber.conf.ts',
    resultsDirName: 'cucumber',
  },
  'cucumber-retry-all': {
    configPath: 'tests/wdio.cucumber.conf.ts',
    resultsDirName: 'cucumber-retry-all',
    retryAttempts: 'all',
  },
  'cucumber-retry-retries': {
    configPath: 'tests/wdio.cucumber.conf.ts',
    resultsDirName: 'cucumber-retry-retries',
    retryAttempts: 'retries',
  },
  'cucumber-duplicate-names': {
    configPath: 'tests/wdio.cucumber.conf.ts',
    resultsDirName: 'cucumber-duplicate-names',
    duplicateNames: true,
  },
}

const resolveExpectedTitle = (framework: FrameworkMode): string => {
  if (framework === 'jasmine') {
    return 'jasmine style should keep test name in video filename'
  }
  if (framework === 'cucumber') {
    return 'cucumber style should keep scenario name in video filename'
  }
  return CUCUMBER_RETRY_TITLE
}

const resolveExpectedTitles = (framework: FrameworkMode): string[] => {
  if (framework === 'jasmine') {
    return [
      resolveExpectedTitle(framework),
      'jasmine style should retain an explicitly pending recording',
    ]
  }
  return framework === 'cucumber-duplicate-names'
    ? [...CUCUMBER_DUPLICATE_TITLES]
    : [resolveExpectedTitle(framework)]
}

const runWdioFramework = async (
  framework: FrameworkMode,
  environment: E2eEnvironment,
): Promise<void> => {
  const target = frameworkConfigMap[framework]
  const nodeCommand = process.execPath
  const wdioCliPath = path.resolve('node_modules/@wdio/cli/bin/wdio.js')
  const resultsDir = path.resolve('tests/results', target.resultsDirName)
  const configPath = path.resolve(target.configPath)

  console.log(
    `[e2e:frameworks] Starting ${framework} run. Artifacts => ${resultsDir}`,
  )

  const child = spawn(nodeCommand, [wdioCliPath, 'run', configPath], {
    stdio: 'inherit',
    windowsHide: true,
    env: environment.childEnvironment({
      WDIO_RESULTS_DIR: resultsDir,
      ...(target.retryAttempts
        ? { WDIO_CUCUMBER_RETRY_MODE: target.retryAttempts }
        : {}),
      ...(target.duplicateNames ? { WDIO_CUCUMBER_DUPLICATE_NAMES: '1' } : {}),
    }),
  })

  await waitForChildProcess(child, (code) => {
    return `[e2e:frameworks] ${framework} run failed with code ${code}`
  })
  const expectedTitles = resolveExpectedTitles(framework)
  await assertStaticVideoReport({
    resultsDir,
    expectedTitles,
    ...(target.retryAttempts ? { expectRetryOutcomes: true } : {}),
    runLabel: framework,
  })
  await assertAllureVideoAttachments({
    resultsDir,
    expectedTitles,
    runLabel: `${framework}-allure`,
  })
  if (framework === 'jasmine') {
    await assertManifestMediaDimensions(
      resultsDir,
      environment.ffmpegDetection.resolvedPath,
    )
    const manifest: unknown = JSON.parse(
      await readFile(path.join(resultsDir, 'manifest.json'), 'utf8'),
    )
    assert.ok(isVideoManifest(manifest))
    const entries = manifest.runs.flatMap((run) => run.entries)
    assert.equal(entries.length, 2)
    const pendingEntry = entries.find((entry) =>
      entry.test?.name.includes('explicitly pending'),
    )
    assert.equal(pendingEntry?.result, 'skipped')
    assert.equal(pendingEntry?.capture.decision, 'recorded')
  }
  if (target.retryAttempts) {
    await assertCucumberRetryAttempts(resultsDir, target.retryAttempts)
  }
  if (target.duplicateNames) {
    await assertDistinctScenarioMedia(resultsDir)
  }

  console.log(`[e2e:frameworks] Completed ${framework} run.`)
}

const environment = await startE2eEnvironment()
try {
  for (const framework of frameworkOrder) {
    // Run sequentially so results and logs stay isolated per framework.
    await runWdioFramework(framework, environment)
  }
} finally {
  await environment.close()
}

console.log('[e2e:frameworks] All requested framework runs completed.')
