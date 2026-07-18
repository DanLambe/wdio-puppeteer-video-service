import {
  type FixtureServer,
  startFixtureServer,
} from '../fixtures/fixture-server.js'
import type { FfmpegDetectionResult } from './ffmpeg-detection.js'
import { requireE2eFfmpeg } from './ffmpeg-detection.js'

export interface E2eEnvironment {
  ffmpegDetection: FfmpegDetectionResult
  fixtureServer: FixtureServer
  childEnvironment: (overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  close: () => Promise<void>
}

export const startE2eEnvironment = async (): Promise<E2eEnvironment> => {
  const ffmpegDetection = await requireE2eFfmpeg()
  const fixtureServer = await startFixtureServer()

  return {
    ffmpegDetection,
    fixtureServer,
    childEnvironment: (overrides = {}) => ({
      ...process.env,
      WDIO_FIXTURE_BASE_URL: fixtureServer.baseUrl,
      WDIO_FIXTURE_CROSS_ORIGIN_URL: fixtureServer.crossOriginUrl,
      WDIO_EXPECT_VIDEOS: ffmpegDetection.available ? '1' : '0',
      ...(ffmpegDetection.resolvedPath
        ? { FFMPEG_PATH: ffmpegDetection.resolvedPath }
        : {}),
      ...overrides,
    }),
    close: fixtureServer.close,
  }
}
