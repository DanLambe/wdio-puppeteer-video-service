import {
  getFfmpegCandidates,
  resolveAvailableFfmpegPath,
} from '../../src/service/ffmpeg.js'

export type FfmpegDetectionResult = {
  available: boolean
  resolvedPath?: string
  checkedCandidates: string[]
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
