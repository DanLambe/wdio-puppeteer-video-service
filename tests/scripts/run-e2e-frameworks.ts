import { spawn } from 'node:child_process'
import path from 'node:path'
import { assertAllureVideoAttachments } from '../utils/allure-assertions.js'
import { assertStaticVideoReport } from '../utils/video-artifact-assertions.js'
import { waitForChildProcess } from './child-process.js'
import { type E2eEnvironment, startE2eEnvironment } from './e2e-environment.js'

type FrameworkMode = 'jasmine' | 'cucumber'

const requestedMode = process.argv[2] || 'both'

const resolveFrameworkOrder = (mode: string): FrameworkMode[] => {
  if (mode === 'both') {
    return ['jasmine', 'cucumber']
  }
  if (mode === 'jasmine' || mode === 'cucumber') {
    return [mode]
  }
  return []
}

const frameworkOrder: FrameworkMode[] = resolveFrameworkOrder(requestedMode)

if (frameworkOrder.length === 0) {
  console.error(
    `[e2e:frameworks] Invalid mode "${requestedMode}". Use jasmine, cucumber, or both.`,
  )
  process.exit(1)
}

const frameworkConfigMap: Record<
  FrameworkMode,
  {
    configPath: string
    resultsDirName: string
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
    }),
  })

  await waitForChildProcess(child, (code) => {
    return `[e2e:frameworks] ${framework} run failed with code ${code}`
  })
  await assertStaticVideoReport({
    resultsDir,
    expectedTitles: [
      framework === 'jasmine'
        ? 'jasmine style should keep test name in video filename'
        : 'cucumber style should keep scenario name in video filename',
    ],
    runLabel: framework,
  })
  await assertAllureVideoAttachments({
    resultsDir,
    expectedTitles: [
      framework === 'jasmine'
        ? 'jasmine style should keep test name in video filename'
        : 'cucumber style should keep scenario name in video filename',
    ],
    runLabel: `${framework}-allure`,
  })

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
