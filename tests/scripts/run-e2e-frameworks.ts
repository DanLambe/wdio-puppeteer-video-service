import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isVideoManifest } from '../../src/manifest.js'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
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
    mode === 'cucumber-retry-retries'
  ) {
    return [mode]
  }
  return []
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
    `[e2e:frameworks] Invalid mode "${requestedMode}". Use jasmine, cucumber, cucumber-retry, cucumber-retry-all, cucumber-retry-retries, or both.`,
  )
  process.exit(1)
}

const frameworkConfigMap: Record<
  FrameworkMode,
  {
    configPath: string
    resultsDirName: string
    retryAttempts?: 'all' | 'retries'
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
    }),
  })

  await waitForChildProcess(child, (code) => {
    return `[e2e:frameworks] ${framework} run failed with code ${code}`
  })
  const expectedTitle = resolveExpectedTitle(framework)
  await assertStaticVideoReport({
    resultsDir,
    expectedTitles: [expectedTitle],
    ...(target.retryAttempts ? { expectRetryOutcomes: true } : {}),
    runLabel: framework,
  })
  await assertAllureVideoAttachments({
    resultsDir,
    expectedTitles: [expectedTitle],
    runLabel: `${framework}-allure`,
  })
  if (target.retryAttempts) {
    await assertCucumberRetryAttempts(resultsDir, target.retryAttempts)
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
