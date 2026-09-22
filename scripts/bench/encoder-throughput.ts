// Encoder-only throughput benchmark: no browser, no WDIO.
//
// Feeds a fixed PNG frame to FFmpeg the way `ScreencastRecorder` does - one
// `image2pipe` stream of PNG buffers - and measures how fast each encoder
// configuration drains them. The number that matters is `realtimeRatio`: the
// encoded frames per second divided by the capture rate. Below 1.0 the encoder
// falls behind the capture grid for the whole test, so `stop()` inherits a
// backlog it cannot drain inside the stop deadline.
//
// Pair this with `pipeline.ts`, which measures the same thing end to end.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface EncoderSettings {
  readonly label: string
  readonly codec: 'vp9' | 'h264'
  /** libvpx `-cpu-used` (0-8) or libx264 `-preset`. */
  readonly speed: string
  readonly threads: number
  readonly crf: number
}

export interface EncoderRunResult {
  readonly label: string
  readonly codec: string
  readonly speed: string
  readonly threads: number
  readonly crf: number
  readonly seconds: number
  readonly framesPerSecond: number
  readonly realtimeRatio: number
  readonly bytes: number
}

export interface BenchmarkOptions {
  readonly ffmpegPath: string
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly fps: number
  readonly encoders: number
}

// Mirrors `createFfmpegArguments` in src/service/screencast-recorder.ts. The
// input and filter stages stay identical so the encoder is the only variable.
export const buildEncoderArguments = (
  settings: EncoderSettings,
  options: Pick<BenchmarkOptions, 'fps' | 'width' | 'height'>,
): string[] => {
  const { width, height } = options
  const codecStage =
    settings.codec === 'vp9'
      ? [
          '-vcodec',
          'vp9',
          '-crf',
          String(settings.crf),
          '-b:v',
          '0',
          '-deadline',
          'realtime',
          '-cpu-used',
          settings.speed,
          '-f',
          'webm',
        ]
      : [
          '-vcodec',
          'libx264',
          '-crf',
          String(settings.crf),
          '-preset',
          settings.speed,
          '-tune',
          'zerolatency',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          'frag_keyframe+empty_moov',
          '-f',
          'mp4',
        ]
  const cropExpression = `crop='min(${width},iw):min(${height},ih):0:0'`
  return [
    '-loglevel',
    'error',
    '-framerate',
    String(options.fps),
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-i',
    'pipe:0',
    '-an',
    '-threads',
    String(settings.threads),
    ...codecStage,
    '-vf',
    [cropExpression, `pad=${width}:${height}:0:0`].join(),
    '-y',
    'pipe:1',
  ]
}

interface SingleRun {
  readonly seconds: number
  readonly bytes: number
}

const runOneEncoder = async (
  settings: EncoderSettings,
  options: BenchmarkOptions,
  frame: Buffer,
): Promise<SingleRun> => {
  const args = buildEncoderArguments(settings, options)
  return await new Promise<SingleRun>((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(options.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let bytes = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000)
    })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            'ffmpeg exited ' +
              exitCode +
              ' for "' +
              settings.label +
              '": ' +
              stderr.trim(),
          ),
        )
        return
      }
      resolve({ seconds: (performance.now() - startedAt) / 1_000, bytes })
    })
    // Written the way `fillTo` does, so backpressure behaves as it does in the
    // recorder rather than being paced by this script.
    for (let index = 0; index < options.frames; index += 1) {
      child.stdin.write(frame)
    }
    child.stdin.end()
  })
}

export const runEncoderBenchmark = async (
  settings: EncoderSettings,
  options: BenchmarkOptions,
  frame: Buffer,
): Promise<EncoderRunResult[]> => {
  const runs = await Promise.all(
    Array.from({ length: options.encoders }, () =>
      runOneEncoder(settings, options, frame),
    ),
  )
  return runs.map((run): EncoderRunResult => {
    const framesPerSecond = options.frames / run.seconds
    return {
      label: settings.label,
      codec: settings.codec,
      speed: settings.speed,
      threads: settings.threads,
      crf: settings.crf,
      seconds: Number(run.seconds.toFixed(2)),
      framesPerSecond: Number(framesPerSecond.toFixed(1)),
      realtimeRatio: Number((framesPerSecond / options.fps).toFixed(2)),
      bytes: run.bytes,
    }
  })
}

export const DEFAULT_MATRIX: readonly EncoderSettings[] = [
  {
    label: 'vp9 cpu-used=8 threads=1 (shipping default)',
    codec: 'vp9',
    speed: '8',
    threads: 1,
    crf: 30,
  },
  {
    label: 'vp9 cpu-used=8 threads=2',
    codec: 'vp9',
    speed: '8',
    threads: 2,
    crf: 30,
  },
  {
    label: 'vp9 cpu-used=4 threads=1',
    codec: 'vp9',
    speed: '4',
    threads: 1,
    crf: 30,
  },
  {
    label: 'h264 ultrafast threads=1',
    codec: 'h264',
    speed: 'ultrafast',
    threads: 1,
    crf: 30,
  },
  {
    label: 'h264 ultrafast threads=2',
    codec: 'h264',
    speed: 'ultrafast',
    threads: 2,
    crf: 30,
  },
  {
    label: 'h264 veryfast threads=1',
    codec: 'h264',
    speed: 'veryfast',
    threads: 1,
    crf: 30,
  },
]

// A mostly flat frame with one region of hard detail, which is closer to a web
// page than ffmpeg's testsrc alone. A real captured frame is more
// representative still; pass one with `--frame`.
const generateFrame = async (
  ffmpegPath: string,
  width: number,
  height: number,
  destination: string,
): Promise<void> => {
  const args = [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=white:s=${width}x${height}`,
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=' +
      Math.round(width / 3) +
      'x' +
      Math.round(height / 3) +
      ':r=1',
    '-filter_complex',
    '[0:v][1:v]overlay=x=40:y=40',
    '-frames:v',
    '1',
    '-y',
    destination,
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Could not generate a benchmark frame (ffmpeg ${code})`))
    })
  })
}

const parseArguments = (argv: readonly string[]): Map<string, string> => {
  const parsed = new Map<string, string>()
  for (const entry of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(entry)
    const key = match?.[1]
    if (key) {
      parsed.set(key, match?.[2] ?? 'true')
    }
  }
  return parsed
}

const resolveFfmpegPath = async (
  override: string | undefined,
): Promise<string> => {
  if (override) {
    return override
  }
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH
  }
  const staticModule = (await import('ffmpeg-static')) as { default?: unknown }
  if (typeof staticModule.default !== 'string') {
    throw new TypeError(
      'Set --ffmpeg or FFMPEG_PATH: ffmpeg-static did not resolve a binary',
    )
  }
  return staticModule.default
}

const formatTable = (
  results: readonly EncoderRunResult[],
  fps: number,
): string => {
  const rows = results.map((result) => {
    const verdict = result.realtimeRatio >= 1 ? '' : ' **behind**'
    return (
      '| ' +
      result.label +
      ' | ' +
      fps +
      ' | ' +
      result.framesPerSecond +
      ' | ' +
      result.realtimeRatio +
      'x' +
      verdict +
      ' | ' +
      (result.bytes / 1_000_000).toFixed(2) +
      ' |'
    )
  })
  return [
    '| encoder | capture fps | encode fps | realtime | MB |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

export const main = async (argv: readonly string[]): Promise<void> => {
  const args = parseArguments(argv)
  const ffmpegPath = await resolveFfmpegPath(args.get('ffmpeg'))
  const size = (args.get('size') ?? '1920x1080').split('x').map(Number)
  const width = size[0] ?? 1920
  const height = size[1] ?? 1080
  const frames = Number(args.get('frames') ?? 120)
  const fps = Number(args.get('fps') ?? 24)
  const encoders = Number(args.get('encoders') ?? 1)

  let framePath = args.get('frame')
  if (!framePath) {
    framePath = path.join(
      os.tmpdir(),
      `wdio-bench-frame-${width}x${height}.png`,
    )
    await generateFrame(ffmpegPath, width, height, framePath)
  }
  const frame = await fs.readFile(framePath)

  const options: BenchmarkOptions = {
    ffmpegPath,
    width,
    height,
    frames,
    fps,
    encoders,
  }

  console.log(
    'Encoder throughput: ' +
      width +
      'x' +
      height +
      ', ' +
      frames +
      ' frames, capture ' +
      fps +
      ' fps, ' +
      encoders +
      ' parallel encoder(s), ' +
      os.cpus().length +
      ' CPUs visible, frame ' +
      (frame.length / 1_000).toFixed(0) +
      ' kB',
  )

  const results: EncoderRunResult[] = []
  for (const settings of DEFAULT_MATRIX) {
    results.push(...(await runEncoderBenchmark(settings, options, frame)))
  }

  console.log(`\n${formatTable(results, fps)}`)

  const jsonPath = args.get('json')
  if (jsonPath) {
    const resolved = path.resolve(jsonPath)
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    const payload = {
      options: { width, height, frames, fps, encoders, cpus: os.cpus().length },
      results,
    }
    await fs.writeFile(
      resolved,
      `${JSON.stringify(payload, undefined, 2)}\n`,
      'utf8',
    )
    console.log(`\nWrote ${resolved}`)
  }
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  await main(process.argv.slice(2))
}
