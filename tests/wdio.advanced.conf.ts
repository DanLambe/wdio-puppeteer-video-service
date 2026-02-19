import path from 'node:path'
import { emptyDir } from 'fs-extra'
import WdioPuppeteerVideoService from '../src/index.js'
import {
  assertVideoArtifacts,
  listVideoArtifacts,
} from './utils/video-artifact-assertions.js'

type AdvancedMode =
  | 'retry'
  | 'spec-level'
  | 'no-segment'
  | 'session-style'
  | 'session-full-style'
  | 'deferred-merge'
  | 'include-spec'
  | 'exclude-spec'

const toMode = (value: string | undefined): AdvancedMode => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'spec-level') {
    return 'spec-level'
  }
  if (normalized === 'no-segment') {
    return 'no-segment'
  }
  if (normalized === 'session-style') {
    return 'session-style'
  }
  if (normalized === 'session-full-style') {
    return 'session-full-style'
  }
  if (normalized === 'deferred-merge') {
    return 'deferred-merge'
  }
  if (normalized === 'include-spec') {
    return 'include-spec'
  }
  if (normalized === 'exclude-spec') {
    return 'exclude-spec'
  }
  return 'retry'
}

const mode = toMode(process.env.WDIO_ADVANCED_MODE)
const expectVideos = !['0', 'false', 'no'].includes(
  (process.env.WDIO_EXPECT_VIDEOS ?? '1').toLowerCase(),
)
const resultsDir = path.resolve(
  process.env.WDIO_RESULTS_DIR ||
    path.join('tests/results', `advanced-${mode}`),
)

const modeSpecs: Record<AdvancedMode, string[]> = {
  retry: [path.resolve('tests/advanced/specs/retry-recording.spec.ts')],
  'spec-level': [
    path.resolve('tests/advanced/specs/spec-level-recording.spec.ts'),
  ],
  'no-segment': [
    path.resolve('tests/advanced/specs/no-window-segment.spec.ts'),
  ],
  'session-style': [path.resolve('tests/advanced/specs/file-style.spec.ts')],
  'session-full-style': [
    path.resolve('tests/advanced/specs/file-style.spec.ts'),
  ],
  'deferred-merge': [
    path.resolve('tests/advanced/specs/deferred-merge.spec.ts'),
  ],
  'include-spec': [
    path.resolve('tests/advanced/specs/filter-spec-recording.spec.ts'),
  ],
  'exclude-spec': [
    path.resolve('tests/advanced/specs/filter-spec-recording.spec.ts'),
  ],
}

const modeExpectedTitles: Record<AdvancedMode, string[]> = {
  retry: ['should record only when retry attempt executes'],
  'spec-level': ['spec level recording spec'],
  'no-segment': [
    'should keep one segment when window switching segmentation is disabled',
  ],
  'session-style': ['session style placeholder'],
  'session-full-style': ['session full style placeholder'],
  'deferred-merge': [
    'should produce a deferred merged artifact for a multi-window flow',
  ],
  'include-spec': ['should execute when spec filter mode is configured'],
  'exclude-spec': [],
}

const fileStyleTitleToken =
  'unique_title_token_should_not_appear_for_session_style_modes'

type ServiceOptions = Record<string, unknown>

const defaultServiceOptions: ServiceOptions = {
  outputDir: resultsDir,
  saveAllVideos: true,
  maxConcurrentRecordings: 1,
  outputFormat: 'mp4',
  transcode: {
    enabled: true,
  },
  mergeSegments: {
    enabled: false,
  },
}

const createServiceOptions = (overrides: ServiceOptions): ServiceOptions => {
  const transcodeOverrides = overrides.transcode as ServiceOptions | undefined
  const mergeSegmentOverrides = overrides.mergeSegments as
    | ServiceOptions
    | undefined

  return {
    ...defaultServiceOptions,
    ...overrides,
    transcode: {
      ...(defaultServiceOptions.transcode as ServiceOptions),
      ...transcodeOverrides,
    },
    mergeSegments: {
      ...(defaultServiceOptions.mergeSegments as ServiceOptions),
      ...mergeSegmentOverrides,
    },
  }
}

const serviceOptionsByMode: Record<AdvancedMode, ServiceOptions> = {
  retry: createServiceOptions({
    saveAllVideos: false,
    recordOnRetries: true,
  }),
  'spec-level': createServiceOptions({
    specLevelRecording: true,
    skipViewPortKickoff: true,
  }),
  'no-segment': createServiceOptions({
    segmentOnWindowSwitch: false,
  }),
  'session-style': createServiceOptions({
    fileNameStyle: 'session',
  }),
  'session-full-style': createServiceOptions({
    fileNameStyle: 'sessionFull',
  }),
  'deferred-merge': createServiceOptions({
    postProcessMode: 'deferred',
    mergeSegments: {
      enabled: true,
      deleteSegments: true,
    },
  }),
  'include-spec': createServiceOptions({
    includeSpecPatterns: ['*filter-spec-recording*'],
  }),
  'exclude-spec': createServiceOptions({
    excludeSpecPatterns: ['*filter-spec-recording*'],
  }),
}

const assertRetryMode = (artifactNames: string[]): void => {
  if (artifactNames.length !== 1) {
    throw new Error(
      `[wdio:e2e:advanced] retry mode expected exactly 1 artifact but found ${artifactNames.length}: ${artifactNames.join(', ')}`,
    )
  }
  if (!artifactNames[0].includes('_retry1')) {
    throw new Error(
      `[wdio:e2e:advanced] retry mode expected retry token in artifact name, got ${artifactNames[0]}`,
    )
  }
}

const assertSpecLevelMode = (artifactNames: string[]): void => {
  if (artifactNames.length !== 1) {
    throw new Error(
      `[wdio:e2e:advanced] spec-level mode expected exactly 1 artifact but found ${artifactNames.length}: ${artifactNames.join(', ')}`,
    )
  }
  if (!artifactNames[0].startsWith('spec_level_recording_spec_')) {
    throw new Error(
      `[wdio:e2e:advanced] spec-level artifact should use spec token prefix, got ${artifactNames[0]}`,
    )
  }
}

const assertNoSegmentMode = (artifactNames: string[]): void => {
  const hasAdditionalSegments = artifactNames.some((fileName) =>
    /_part[2-9]\d*\./.test(fileName),
  )
  if (hasAdditionalSegments) {
    throw new Error(
      `[wdio:e2e:advanced] no-segment mode expected only first segment artifacts, got ${artifactNames.join(', ')}`,
    )
  }
}

const assertNoLeakedTitleToken = (
  label: string,
  artifactNames: string[],
): void => {
  const leakedTitleToken = artifactNames.some((fileName) =>
    fileName.includes(fileStyleTitleToken),
  )
  if (leakedTitleToken) {
    throw new Error(
      `[wdio:e2e:advanced] ${label} artifact leaked title token: ${artifactNames.join(', ')}`,
    )
  }
}

const assertSessionStyleMode = (artifactNames: string[]): void => {
  const hasInvalidName = artifactNames.some(
    (fileName) =>
      !/^[a-z0-9]{1,12}(?:_run\d+)?_part\d+\.(mp4|webm)$/.test(fileName),
  )
  if (hasInvalidName) {
    throw new Error(
      `[wdio:e2e:advanced] session-style mode found artifact that does not match session naming: ${artifactNames.join(', ')}`,
    )
  }
  assertNoLeakedTitleToken('session-style', artifactNames)
}

const assertSessionFullStyleMode = (artifactNames: string[]): void => {
  const hasInvalidFullSessionName = artifactNames.some(
    (fileName) =>
      !/^[a-z0-9_]{8,64}(?:_run\d+)?_part\d+\.(mp4|webm)$/.test(fileName),
  )
  if (hasInvalidFullSessionName) {
    throw new Error(
      `[wdio:e2e:advanced] session-full-style mode found artifact that does not match full-session naming: ${artifactNames.join(', ')}`,
    )
  }
  assertNoLeakedTitleToken('session-full-style', artifactNames)
}

const assertDeferredMergeMode = (artifactNames: string[]): void => {
  if (artifactNames.length !== 1) {
    throw new Error(
      `[wdio:e2e:advanced] deferred-merge mode expected exactly 1 merged artifact but found ${artifactNames.length}: ${artifactNames.join(', ')}`,
    )
  }
  const hasPartSegment = artifactNames.some((fileName) =>
    /_part\d+\./.test(fileName),
  )
  if (hasPartSegment) {
    throw new Error(
      `[wdio:e2e:advanced] deferred-merge mode expected merged artifact without part suffixes, got ${artifactNames.join(', ')}`,
    )
  }
}

const assertIncludeSpecMode = (artifactNames: string[]): void => {
  if (artifactNames.length !== 1) {
    throw new Error(
      `[wdio:e2e:advanced] include-spec mode expected exactly 1 artifact but found ${artifactNames.length}: ${artifactNames.join(', ')}`,
    )
  }
}

const assertExcludeSpecMode = (artifactNames: string[]): void => {
  if (artifactNames.length !== 0) {
    throw new Error(
      `[wdio:e2e:advanced] exclude-spec mode expected 0 artifacts but found ${artifactNames.length}: ${artifactNames.join(', ')}`,
    )
  }
}

const modeAssertions: Record<AdvancedMode, (names: string[]) => void> = {
  retry: assertRetryMode,
  'spec-level': assertSpecLevelMode,
  'no-segment': assertNoSegmentMode,
  'session-style': assertSessionStyleMode,
  'session-full-style': assertSessionFullStyleMode,
  'deferred-merge': assertDeferredMergeMode,
  'include-spec': assertIncludeSpecMode,
  'exclude-spec': assertExcludeSpecMode,
}

const assertAdvancedModeExpectations = async (
  activeMode: AdvancedMode,
  artifactNames: string[],
): Promise<void> => {
  modeAssertions[activeMode](artifactNames)
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  tsConfigPath: './tsconfig.spec.json',
  specs: modeSpecs[mode],
  maxInstances: 1,
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
  logLevel: 'error',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: [[WdioPuppeteerVideoService, serviceOptionsByMode[mode]]],
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
    let fileNameStyle: 'test' | 'session' | 'sessionFull' = 'test'
    if (mode === 'session-full-style') {
      fileNameStyle = 'sessionFull'
    } else if (mode === 'session-style') {
      fileNameStyle = 'session'
    }

    const modeExpectsNoVideos = mode === 'exclude-spec'
    const mergedArtifactsExpected = mode === 'deferred-merge'
    const expectModeVideos = expectVideos && !modeExpectsNoVideos

    await assertVideoArtifacts({
      resultsDir,
      expectedTitles: modeExpectedTitles[mode],
      expectVideos: expectModeVideos,
      expectZeroVideos: modeExpectsNoVideos,
      mergeSegmentsEnabled: mergedArtifactsExpected,
      fileNameStyle,
      runLabel: `advanced-${mode}`,
    })

    if (!expectVideos && !modeExpectsNoVideos) {
      return
    }

    const mediaFiles = await listVideoArtifacts(resultsDir)
    await assertAdvancedModeExpectations(mode, mediaFiles)
  },
}
