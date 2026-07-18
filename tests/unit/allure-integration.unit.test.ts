import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  type AllureModuleLoader,
  AllureVideoIntegration,
} from '../../src/service/allure-integration.js'

const { defaultAddAttachment } = vi.hoisted(() => ({
  defaultAddAttachment: vi.fn(async () => {}),
}))

vi.mock('@wdio/allure-reporter', () => ({
  default: { addAttachment: defaultAddAttachment },
}))

const createHarness = (
  options: { attach: 'failures' | 'retained'; maxBytes?: number } = {
    attach: 'failures',
  },
) => {
  const addAttachment = vi.fn(async () => {})
  const loadModule = vi.fn(async () => ({
    default: { addAttachment },
  })) satisfies AllureModuleLoader
  const readFile = vi.fn(async (filePath: string) =>
    Buffer.from(`media:${filePath}`),
  )
  const readFileSize = vi.fn(async (filePath: string) =>
    Buffer.byteLength(`media:${filePath}`),
  )
  const log = vi.fn()
  const integration = new AllureVideoIntegration(
    options,
    log,
    loadModule,
    readFile,
    readFileSize,
  )
  return {
    addAttachment,
    integration,
    loadModule,
    log,
    readFile,
    readFileSize,
  }
}

describe('Allure video integration', () => {
  it('does not load Allure or read files for a passing test by default', async () => {
    const harness = createHarness()

    await expect(
      harness.integration.attachRetainedVideos(['passed.mp4'], true),
    ).resolves.toEqual({ attachedPaths: [] })
    expect(harness.loadModule).not.toHaveBeenCalled()
    expect(harness.readFile).not.toHaveBeenCalled()
  })

  it('attaches failed multipart media with exact bytes and MIME types', async () => {
    const harness = createHarness()
    const paths = ['checkout_part1.webm', 'checkout_part2.mp4']

    await expect(
      harness.integration.attachRetainedVideos(paths, false),
    ).resolves.toEqual({ attachedPaths: paths })
    expect(harness.loadModule).toHaveBeenCalledOnce()
    expect(harness.addAttachment).toHaveBeenNthCalledWith(
      1,
      'Video (1/2): checkout_part1.webm',
      Buffer.from('media:checkout_part1.webm'),
      'video/webm',
    )
    expect(harness.addAttachment).toHaveBeenNthCalledWith(
      2,
      'Video (2/2): checkout_part2.mp4',
      Buffer.from('media:checkout_part2.mp4'),
      'video/mp4',
    )
  })

  it('attaches passing retained media when configured', async () => {
    const harness = createHarness({ attach: 'retained' })

    await expect(
      harness.integration.attachRetainedVideos(['passing.mp4'], true),
    ).resolves.toEqual({ attachedPaths: ['passing.mp4'] })
    expect(harness.addAttachment).toHaveBeenCalledOnce()
  })

  it('skips oversized files without treating the limit as an integration failure', async () => {
    const harness = createHarness({ attach: 'retained', maxBytes: 4 })

    await expect(
      harness.integration.attachRetainedVideos(['large.mp4'], true),
    ).resolves.toEqual({ attachedPaths: [] })
    expect(harness.addAttachment).not.toHaveBeenCalled()
    expect(harness.readFile).not.toHaveBeenCalled()
    expect(harness.readFileSize).toHaveBeenCalledWith('large.mp4')
    expect(harness.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('exceeds integrations.allure.maxBytes'),
    )
  })

  it('reports a missing optional peer without throwing from the adapter', async () => {
    const missingPeer = new Error('module not found')
    const loadModule = vi.fn(async () => {
      throw missingPeer
    })
    const log = vi.fn()
    const integration = new AllureVideoIntegration(
      { attach: 'failures' },
      log,
      loadModule,
    )

    const result = await integration.attachRetainedVideos(['failed.mp4'], false)

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.cause).toBe(missingPeer)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('Unable to load optional peer'),
      missingPeer,
    )
  })

  it('reports reporter API and attachment failures with their causes', async () => {
    const invalidModule = new AllureVideoIntegration(
      { attach: 'failures' },
      vi.fn(),
      async () => ({}),
    )
    const invalidResult = await invalidModule.attachRetainedVideos(
      ['failed.mp4'],
      false,
    )
    expect(invalidResult.error?.cause).toBeInstanceOf(TypeError)

    const attachmentError = new Error('writer unavailable')
    const addAttachment = vi
      .fn()
      .mockRejectedValueOnce(attachmentError)
      .mockResolvedValueOnce(undefined)
    const integration = new AllureVideoIntegration(
      { attach: 'failures' },
      vi.fn(),
      async () => ({
        addAttachment,
      }),
      async () => Buffer.from('video'),
    )
    const result = await integration.attachRetainedVideos(
      ['failed_part1.webm', 'failed_part2.webm'],
      false,
    )
    expect(result.error?.cause).toBe(attachmentError)
    expect(result.attachedPaths).toEqual(['failed_part2.webm'])
    expect(addAttachment).toHaveBeenCalledTimes(2)
  })

  it('ignores unsupported retained artifacts and reuses the loaded API', async () => {
    const harness = createHarness({ attach: 'retained' })

    await expect(
      harness.integration.attachRetainedVideos(['notes.txt'], true),
    ).resolves.toEqual({ attachedPaths: [] })
    await harness.integration.attachRetainedVideos(['first.mp4'], true)
    await harness.integration.attachRetainedVideos(['second.mp4'], true)

    expect(harness.loadModule).toHaveBeenCalledOnce()
    expect(harness.addAttachment).toHaveBeenCalledTimes(2)
  })

  it('loads the installed optional peer only when an attachment is needed', async () => {
    defaultAddAttachment.mockClear()
    const integration = new AllureVideoIntegration(
      { attach: 'failures' },
      vi.fn(),
      undefined,
      async () => Buffer.from('installed-peer-video'),
    )

    await integration.attachRetainedVideos(['failed.mp4'], false)

    expect(defaultAddAttachment).toHaveBeenCalledWith(
      'Video: failed.mp4',
      Buffer.from('installed-peer-video'),
      'video/mp4',
    )
  })

  it('reads retained media through the default filesystem boundary', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allure-video-'))
    const videoPath = path.join(tempDir, 'retained.webm')
    const bytes = Buffer.from('retained-media')
    await fs.writeFile(videoPath, bytes)
    const addAttachment = vi.fn(async () => {})
    try {
      const integration = new AllureVideoIntegration(
        { attach: 'retained' },
        vi.fn(),
        async () => ({ default: { addAttachment } }),
      )

      await integration.attachRetainedVideos([videoPath], true)

      expect(addAttachment).toHaveBeenCalledWith(
        'Video: retained.webm',
        bytes,
        'video/webm',
      )
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })
})
