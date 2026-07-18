import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ActiveSegment,
  RECORDER_STOP_TIMEOUT_MS,
} from '../../src/service/constants.js'
import type { RecordingLifecycle } from '../../src/service/recording-lifecycle.js'
import WdioPuppeteerVideoService from '../../src/service.js'

type FakeRecorder = PassThrough & {
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}

const createRecorder = (): FakeRecorder => {
  const recorder = new PassThrough() as FakeRecorder
  recorder.stop = vi.fn(async () => {
    recorder.end()
  })
  return recorder
}

const withTempDir = async (
  run: (tempDir: string) => Promise<void>,
): Promise<void> => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wdio-video-lifecycle-'),
  )
  try {
    await run(tempDir)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

type StartHarness = {
  _activeSegment: ActiveSegment | undefined
  _browser: unknown
  _createRecordingOutput: () => {
    outputFormat: 'webm'
    outputPath: string
    recordingFormat: 'webm'
    recordingPath: string
    transcodeEnabled: false
  }
  _currentTestSlug: string
  _ensureFfmpegReady: () => Promise<boolean>
  _prepareRecordingPage: () => Promise<{
    page: {
      screencast: () => Promise<FakeRecorder>
    }
    windowHandle: string
  }>
  _recorder: FakeRecorder | undefined
  _recordedSegments: Set<string>
  _recordingLifecycle: RecordingLifecycle
  _recordingSlotScheduler: {
    acquire: () => Promise<boolean>
    release: () => Promise<void>
  }
  _startRecording: () => Promise<boolean>
  _stopRecording: () => Promise<void>
}

const createStartHarness = (
  tempDir: string,
  recorder: FakeRecorder,
): {
  artifactPath: string
  release: ReturnType<typeof vi.fn<() => Promise<void>>>
  screencast: ReturnType<typeof vi.fn<() => Promise<FakeRecorder>>>
  service: StartHarness
} => {
  const artifactPath = path.join(tempDir, 'lifecycle_part1.webm')
  const release = vi.fn(async () => {})
  const screencast = vi.fn(async () => recorder)
  const service = new WdioPuppeteerVideoService({
    logLevel: 'silent',
    outputDir: tempDir,
    skipViewPortKickoff: true,
  }) as unknown as StartHarness

  service._browser = {}
  service._currentTestSlug = 'lifecycle'
  service._ensureFfmpegReady = async () => true
  service._recordingSlotScheduler = {
    acquire: async () => true,
    release,
  }
  service._prepareRecordingPage = async () => ({
    page: { screencast },
    windowHandle: 'window-1',
  })
  service._createRecordingOutput = () => ({
    outputFormat: 'webm',
    outputPath: artifactPath,
    recordingFormat: 'webm',
    recordingPath: artifactPath,
    transcodeEnabled: false,
  })

  return { artifactPath, release, screencast, service }
}

describe('WdioPuppeteerVideoService lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('deduplicates concurrent starts and stops while preserving media', async () => {
    await withTempDir(async (tempDir) => {
      const recorder = createRecorder()
      const { artifactPath, release, screencast, service } = createStartHarness(
        tempDir,
        recorder,
      )

      const [firstStart, secondStart] = await Promise.all([
        service._startRecording(),
        service._startRecording(),
      ])
      expect(firstStart).toBe(true)
      expect(secondStart).toBe(true)
      expect(screencast).toHaveBeenCalledOnce()
      expect(service._recordingLifecycle.state).toBe('recording')

      recorder.write('recorded-bytes')
      await Promise.all([service._stopRecording(), service._stopRecording()])

      expect(recorder.stop).toHaveBeenCalledOnce()
      expect(release).toHaveBeenCalledOnce()
      expect(service._recordingLifecycle.state).toBe('completed')
      await expect(fs.readFile(artifactPath, 'utf8')).resolves.toBe(
        'recorded-bytes',
      )
    })
  })

  it('cleans up a recorder and output stream when piping fails with EPIPE', async () => {
    await withTempDir(async (tempDir) => {
      const recorder = createRecorder()
      vi.spyOn(recorder, 'pipe').mockImplementation(() => {
        const error = new Error('pipe closed') as NodeJS.ErrnoException
        error.code = 'EPIPE'
        throw error
      })
      const { artifactPath, release, service } = createStartHarness(
        tempDir,
        recorder,
      )

      await expect(service._startRecording()).resolves.toBe(false)

      expect(recorder.stop).toHaveBeenCalledOnce()
      expect(recorder.destroyed).toBe(true)
      expect(release).toHaveBeenCalledOnce()
      expect(service._recorder).toBeUndefined()
      expect(service._activeSegment).toBeUndefined()
      expect(service._recordingLifecycle.state).toBe('failed')
      await expect(fs.stat(artifactPath)).rejects.toThrow()
    })
  })

  it('preserves a segment when its output stream reports EPIPE during stop', async () => {
    await withTempDir(async (tempDir) => {
      const recorder = createRecorder()
      const { artifactPath, service } = createStartHarness(tempDir, recorder)
      await service._startRecording()
      recorder.write('recoverable-media')
      const error = new Error('broken pipe') as NodeJS.ErrnoException
      error.code = 'EPIPE'
      service._activeSegment?.onWriteStreamError(error)

      await service._stopRecording()

      expect(service._recordingLifecycle.state).toBe('completed')
      expect(service._recordedSegments.has(artifactPath)).toBe(true)
      await expect(fs.readFile(artifactPath, 'utf8')).resolves.toBe(
        'recoverable-media',
      )
    })
  })

  it('releases its slot and preserves source media when finalization fails', async () => {
    await withTempDir(async (tempDir) => {
      const recorder = createRecorder()
      const { artifactPath, release, service } = createStartHarness(
        tempDir,
        recorder,
      ) as ReturnType<typeof createStartHarness> & {
        service: StartHarness & {
          _finalizeSegment: () => Promise<void>
        }
      }
      await service._startRecording()
      recorder.write('unprocessed-media')
      service._finalizeSegment = async () => {
        throw new Error('finalization failed')
      }

      await expect(service._stopRecording()).rejects.toThrow(
        'finalization failed',
      )

      expect(release).toHaveBeenCalledOnce()
      expect(service._recordingLifecycle.state).toBe('failed')
      await expect(fs.readFile(artifactPath, 'utf8')).resolves.toBe(
        'unprocessed-media',
      )
    })
  })

  it('releases the recording slot when a destroyed target fails preparation', async () => {
    await withTempDir(async (tempDir) => {
      const recorder = createRecorder()
      const { release, service } = createStartHarness(tempDir, recorder)
      service._prepareRecordingPage = async () => {
        throw new Error('Target closed')
      }

      await expect(service._startRecording()).resolves.toBe(false)

      expect(recorder.stop).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
      expect(service._recordingLifecycle.state).toBe('failed')
    })
  })

  it('destroys a recorder whose stop operation never settles', async () => {
    vi.useFakeTimers()
    const recorder = createRecorder()
    recorder.stop.mockImplementation(() => new Promise<void>(() => {}))
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _stopRecorder: (recorder: FakeRecorder) => Promise<void>
    }

    const stopTask = service._stopRecorder(recorder)
    await vi.advanceTimersByTimeAsync(RECORDER_STOP_TIMEOUT_MS)
    await stopTask

    expect(recorder.destroyed).toBe(true)
  })

  it('destroys a recorder left behind by a partial start', async () => {
    const recorder = createRecorder()
    const release = vi.fn(async () => {})
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _activeSegment: undefined
      _recorder: FakeRecorder
      _recordingSlotScheduler: {
        acquire: () => Promise<boolean>
        release: () => Promise<void>
      }
      _stopRecording: () => Promise<void>
    }
    service._recorder = recorder
    service._activeSegment = undefined
    service._recordingSlotScheduler = {
      acquire: async () => true,
      release,
    }

    await service._stopRecording()

    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(recorder.destroyed).toBe(true)
    expect(release).toHaveBeenCalledOnce()
  })

  it('runs concurrent and repeated teardown hooks once without retaining state', async () => {
    let releaseStop: (() => void) | undefined
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const service = new WdioPuppeteerVideoService({
      logLevel: 'silent',
    }) as unknown as {
      _browser: unknown
      _currentTestSlug: string
      _flushDeferredPostProcessTasks: () => Promise<void>
      _isChromium: boolean
      _recordingSlotScheduler: {
        ownsGlobalRecordingSlot: boolean
        ownsRecordingSlot: boolean
      }
      _resetTestState: () => Promise<void>
      _sessionIdToken: string
      _stopRecording: () => Promise<void>
      after: () => Promise<void>
      afterSession: () => Promise<void>
      onReload: (oldSessionId: string, newSessionId: string) => Promise<void>
    }
    const stopRecording = vi.fn(async () => {
      await stopGate
    })
    const resetTestState = vi.fn(async () => {
      service._currentTestSlug = ''
    })
    const flushDeferredPostProcessTasks = vi.fn(async () => {})
    service._browser = {}
    service._isChromium = true
    service._currentTestSlug = 'interrupted-test'
    service._recordingSlotScheduler = {
      ownsGlobalRecordingSlot: false,
      ownsRecordingSlot: false,
    }
    service._stopRecording = stopRecording
    service._resetTestState = resetTestState
    service._flushDeferredPostProcessTasks = flushDeferredPostProcessTasks

    const tasks = [
      service.after(),
      service.afterSession(),
      service.onReload('old-session', 'new-session'),
    ]
    releaseStop?.()
    await Promise.all(tasks)

    expect(stopRecording).toHaveBeenCalledOnce()
    expect(resetTestState).toHaveBeenCalledOnce()
    expect(flushDeferredPostProcessTasks).toHaveBeenCalledOnce()
    expect(service._currentTestSlug).toBe('')
    expect(service._browser).toBeUndefined()
    expect(service._isChromium).toBe(false)
    expect(service._sessionIdToken).not.toBe('')

    await service.after()
    await service.afterSession()
    expect(stopRecording).toHaveBeenCalledOnce()
    expect(resetTestState).toHaveBeenCalledOnce()
  })

  it('routes Cucumber teardown through the shared finalizer', async () => {
    const service = new WdioPuppeteerVideoService({}) as unknown as {
      _afterTestOrScenario: (passed: boolean) => Promise<void>
      afterScenario: (
        world: unknown,
        result: { passed: boolean },
      ) => Promise<void>
    }
    const finalize = vi.fn(async () => {})
    service._afterTestOrScenario = finalize

    await service.afterScenario({}, { passed: false })

    expect(finalize).toHaveBeenCalledWith(false)
  })
})
