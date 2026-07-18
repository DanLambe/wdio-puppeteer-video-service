import {
  getFfmpegCandidates,
  resolveAvailableFfmpegPath,
} from '../../src/service/ffmpeg.js'

export type FfmpegDetectionResult = {
  available: boolean
  resolvedPath?: string
  checkedCandidates: string[]
}

const isEnabled = (value: string | undefined): boolean => {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase())
}

export const assertE2eFfmpegPolicy = (
  detection: FfmpegDetectionResult,
  environment: NodeJS.ProcessEnv = process.env,
): void => {
  if (detection.available) {
    return
  }

  const candidates = detection.checkedCandidates.join(', ') || 'no candidates'
  if (isEnabled(environment.CI)) {
    throw new Error(
      `[e2e] FFmpeg is required in CI but was not detected (${candidates}).`,
    )
  }

  if (!isEnabled(environment.WDIO_ALLOW_MISSING_FFMPEG)) {
    throw new Error(
      `[e2e] FFmpeg was not detected (${candidates}). Install FFmpeg or explicitly set WDIO_ALLOW_MISSING_FFMPEG=1 for a local browser-only run.`,
    )
  }
}

export const detectFfmpeg = async (): Promise<FfmpegDetectionResult> => {
  const checkedCandidates = getFfmpegCandidates(
    undefined,
    process.env.FFMPEG_PATH?.trim(),
  )
  const resolvedPath = await resolveAvailableFfmpegPath(checkedCandidates)

  if (resolvedPath) {
    return {
      available: true,
      resolvedPath,
      checkedCandidates,
    }
  }

  return {
    available: false,
    checkedCandidates,
  }
}

export const requireE2eFfmpeg = async (): Promise<FfmpegDetectionResult> => {
  const detection = await detectFfmpeg()
  assertE2eFfmpegPolicy(detection)

  if (!detection.available) {
    console.warn(
      '[e2e] FFmpeg media assertions are explicitly disabled for this local run.',
    )
  }

  return detection
}
