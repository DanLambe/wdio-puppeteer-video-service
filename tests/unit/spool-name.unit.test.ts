import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  formatSpoolFileName,
  parseSpoolFileName,
} from '../../src/service/spool-name.js'

describe('spool file names', () => {
  it('names a spool after its segment and a UUID, and recognizes that name', () => {
    const uuid = randomUUID()

    const name = formatSpoolFileName({ part: 3, slug: 'checkout_run2', uuid })

    expect(name).toBe(`checkout_run2_part3.${uuid}.mkv`)
    expect(parseSpoolFileName(name ?? '')).toEqual({
      segmentName: 'checkout_run2_part3',
    })
  })

  it('recognizes every name it forms', () => {
    for (let part = 1; part <= 12; part += 1) {
      const name = formatSpoolFileName({
        part,
        slug: `spec_${part.toString()}_test`,
        uuid: randomUUID(),
      })
      expect(name).toBeDefined()
      expect(parseSpoolFileName(name ?? '')?.segmentName).toBe(
        `spec_${part.toString()}_test_part${part.toString()}`,
      )
    }
  })

  it.each([
    ['a UUID of another shape', { part: 1, slug: 'checkout', uuid: 'uuid-1' }],
    ['an empty slug', { part: 1, slug: '', uuid: randomUUID() }],
    ['a slug with a dot', { part: 1, slug: 'a.b', uuid: randomUUID() }],
    ['a slug with a separator', { part: 1, slug: 'a/b', uuid: randomUUID() }],
    ['part 0', { part: 0, slug: 'checkout', uuid: randomUUID() }],
    ['a fractional part', { part: 1.5, slug: 'checkout', uuid: randomUUID() }],
  ])('forms no name it would not recognize: %s', (_name, input) => {
    expect(formatSpoolFileName(input)).toBeUndefined()
  })

  it.each([
    'notes.mkv',
    'video.mkv',
    'checkout_part1.mkv',
    'checkout_part1.frames.mkv',
    'checkout_part1.webm',
    'checkout_part01.0f1e2d3c-4b5a-4968-8776-000000000001.mkv',
    'checkout_part1.0F1E2D3C-4B5A-4968-8776-000000000001.mkv',
    'checkout_part1.0f1e2d3c-4b5a-4968-8776-000000000001.mkv.tmp',
    'checkout_part1.0f1e2d3c-4b5a-4968-8776-00000000001.mkv',
    'Checkout_part1.0f1e2d3c-4b5a-4968-8776-000000000001.mkv',
    '_part1.0f1e2d3c-4b5a-4968-8776-000000000001.mkv',
  ])('does not recognize %j', (name) => {
    expect(parseSpoolFileName(name)).toBeUndefined()
  })
})
