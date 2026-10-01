import { describe, expect, it, vi } from 'vitest'
import {
  resolveBaseline,
  resolveImage,
} from '../../scripts/bench/pipeline/inputs.js'

const imageId = `sha256:${'a'.repeat(64)}`

describe('pipeline input resolution', () => {
  it.each([40, 64])('accepts a %i-character Git object ID', (length) => {
    const sha = 'a'.repeat(length)
    const execute = vi.fn(() => sha)
    expect(resolveBaseline(execute, 'HEAD~1')).toBe(sha)
    expect(execute).toHaveBeenCalledWith('git', [
      'rev-parse',
      '--verify',
      '--end-of-options',
      'HEAD~1^{commit}',
    ])
  })

  it('passes an option-like Git reference after the option terminator', () => {
    const execute = vi.fn(() => {
      throw new Error('Not a revision')
    })
    expect(() => resolveBaseline(execute, '--help')).toThrow('Not a revision')
    expect(execute.mock.calls[0]).toEqual([
      'git',
      ['rev-parse', '--verify', '--end-of-options', '--help^{commit}'],
    ])
  })

  it.each(['', 'HEAD', 'abc123', `${'a'.repeat(40)}\n${'b'.repeat(40)}`])(
    'rejects an unresolved or multiple Git result: %s',
    (result) => {
      expect(() => resolveBaseline(() => result, 'HEAD')).toThrow(
        'single commit',
      )
    },
  )

  it.each([
    'wdio-video-pipeline:local',
    'localhost:5000/team/image:tag',
    imageId,
  ])(
    'inspects only an image and resolves its immutable ID: %s',
    (reference) => {
      const execute = vi.fn(() => imageId)
      expect(resolveImage(execute, reference)).toBe(imageId)
      expect(execute).toHaveBeenCalledWith('docker', [
        'inspect',
        '--type=image',
        '--format',
        '{{.Id}}',
        '--',
        reference,
      ])
    },
  )

  it.each([
    '',
    '--help',
    '--format={{json .}}',
    'image\n--help',
    'image --help',
  ])('rejects malformed image operands before executing: %s', (reference) => {
    const execute = vi.fn(() => imageId)
    expect(() => resolveImage(execute, reference)).toThrow('Docker image')
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['', 'image:tag', 'a'.repeat(64), `${imageId}\n${imageId}`])(
    'rejects a non-image or multiple inspection result: %s',
    (result) => {
      expect(() => resolveImage(() => result, 'image:tag')).toThrow(
        'immutable image',
      )
    },
  )
})
