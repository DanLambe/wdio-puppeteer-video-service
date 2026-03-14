import { describe, expect, it } from 'vitest'
import {
  buildFullSessionIdToken,
  buildSessionIdToken,
  buildTestSlugFromMetadata,
  collectSlugMetadata,
  reserveUniqueSlug,
  sanitizeFileToken,
} from '../../src/video-name-utils.js'

describe('video-name-utils helpers', () => {
  it('sanitizes names into lowercase file tokens and trims trailing separators after truncation', () => {
    expect(sanitizeFileToken(' Checkout: Add Item! ', 40)).toBe(
      'checkout_add_item',
    )
    expect(sanitizeFileToken('abc d', 4)).toBe('abc')
  })

  it('builds short and full session id tokens', () => {
    expect(buildSessionIdToken('ABCDEF12-3456-7890-abcd-ef1234567890')).toBe(
      'abcdef12',
    )
    expect(buildFullSessionIdToken('ABCDEF12-3456-7890-abcd-ef1234567890')).toBe(
      'abcdef12_3456_7890_abcd_ef1234567890',
    )
  })

  it('extracts the file token and picks retry metadata from context when present', () => {
    const metadata = collectSlugMetadata(
      {
        title: 'test',
        file: 'tests/specs/checkout.spec.ts',
      } as never,
      {
        currentTest: {
          _currentRetry: 2,
        },
      },
    )

    expect(metadata.fileToken).toBe('checkout_spec')
    expect(metadata.testNameToken).toBe('test')
    expect(metadata.retryToken).toBe('_retry2')
  })

  it('builds session-only slugs and falls back cleanly when the slug budget is tight', () => {
    const slug = buildTestSlugFromMetadata(
      {
        retryToken: '_retry2',
        fileToken: 'checkout',
        testNameToken: 'checkout_adds_item_to_cart',
        hashInput: 'checkout|adds-item',
      },
      {
        fileNameStyle: 'session',
        fileNameOverflowStrategy: 'truncate',
        maxSlugLength: 15,
        sessionIdToken: 'abcdef12',
        sessionIdFullToken: 'abcdef12_full_session',
      },
    )

    expect(slug).toBe('abcdef12_retry2')
  })

  it('appends run suffixes while keeping the slug within the maximum length', () => {
    const slugUsageCount = new Map<string, number>()

    expect(reserveUniqueSlug('very-long-slug-name', 14, slugUsageCount)).toBe(
      'very_long_slug',
    )
    expect(reserveUniqueSlug('very-long-slug-name', 14, slugUsageCount)).toBe(
      'very_long_run2',
    )
  })
})
