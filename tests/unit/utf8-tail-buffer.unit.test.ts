import { describe, expect, it } from 'vitest'
import { Utf8TailBuffer } from '../../src/service/utf8-tail-buffer.js'

describe('Utf8TailBuffer', () => {
  it('retains a bounded tail without splitting UTF-8 or surrogate pairs', () => {
    const tail = new Utf8TailBuffer(8)
    const content = Buffer.from('ab🚨cdefgh')
    const marker = content.indexOf(Buffer.from('🚨'))

    tail.append(content.subarray(0, marker + 2))
    tail.append(content.subarray(marker + 2))

    expect(tail.finish()).toBe('🚨cdefgh')
  })

  it('does not retain a trailing surrogate when trimming the tail', () => {
    const tail = new Utf8TailBuffer(8)

    tail.append(Buffer.from('a🚨bcdefgh'))

    expect(tail.finish()).toBe('bcdefgh')
  })
})
