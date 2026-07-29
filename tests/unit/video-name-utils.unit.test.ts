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
    expect(sanitizeFileToken(undefined, 10)).toBe('')
    expect(sanitizeFileToken('!!!', 10)).toBe('')
    expect(sanitizeFileToken('a---b', 10)).toBe('a_b')
  })

  it('builds short and full session id tokens', () => {
    expect(buildSessionIdToken('ABCDEF12-3456-7890-abcd-ef1234567890')).toBe(
      'abcdef12',
    )
    expect(
      buildFullSessionIdToken('ABCDEF12-3456-7890-abcd-ef1234567890'),
    ).toBe('abcdef12_3456_7890_abcd_ef1234567890')
    expect(buildSessionIdToken('---fallback-session')).toBe('fallback_ses')
    expect(buildSessionIdToken(undefined)).toBe('')
    expect(buildFullSessionIdToken(undefined)).toBe('')
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

    expect(
      buildTestSlugFromMetadata(
        {
          retryToken: '',
          fileToken: 'checkout',
          testNameToken: 'ignored',
          hashInput: 'session-full',
        },
        {
          fileNameStyle: 'session-full',
          fileNameOverflowStrategy: 'truncate',
          maxSlugLength: 40,
          sessionIdToken: '',
          sessionIdFullToken: 'full-session-id',
        },
      ),
    ).toBe('full_session_id')

    expect(
      buildTestSlugFromMetadata(
        {
          retryToken: '_retry123',
          fileToken: 'checkout',
          testNameToken: 'ignored',
          hashInput: 'tight-session',
        },
        {
          fileNameStyle: 'session',
          fileNameOverflowStrategy: 'truncate',
          maxSlugLength: 8,
          sessionIdToken: '',
          sessionIdFullToken: 'fallback-session',
        },
      ),
    ).toBe('fallba_retry123')
  })

  it('builds deterministic test slugs across normal and compact overflow budgets', () => {
    const metadata = {
      retryToken: '_retry3',
      fileToken: 'checkout_spec',
      testNameToken: 'adds an item to the cart',
      hashInput: 'checkout|adds-item|3',
    }
    const normal = buildTestSlugFromMetadata(metadata, {
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      maxSlugLength: 80,
      sessionIdToken: 'abcdef12',
      sessionIdFullToken: 'abcdef12_full',
    })
    expect(normal).toMatch(
      /^adds_an_item_to_the_cart_abcdef12_[a-f0-9]{8}_retry3$/u,
    )

    const sessionOverflow = buildTestSlugFromMetadata(metadata, {
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'session',
      maxSlugLength: 24,
      sessionIdToken: 'abcdef12',
      sessionIdFullToken: 'abcdef12_full',
    })
    expect(sessionOverflow.length).toBeLessThanOrEqual(24)
    expect(sessionOverflow).toContain('abcdef12')

    const sessionPreferred = buildTestSlugFromMetadata(metadata, {
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'session',
      maxSlugLength: 60,
      sessionIdToken: '',
      sessionIdFullToken: '',
    })
    expect(sessionPreferred).toMatch(
      /^adds_an_item_to_the_cart_[a-f0-9]{8}_retry3$/u,
    )

    const fallbackMetadata = { ...metadata, testNameToken: '!!!' }
    expect(
      buildTestSlugFromMetadata(fallbackMetadata, {
        fileNameStyle: 'test',
        fileNameOverflowStrategy: 'session',
        maxSlugLength: 60,
        sessionIdToken: '',
        sessionIdFullToken: '',
      }),
    ).toMatch(/^checkout_spec_[a-f0-9]{8}_retry3$/u)
    expect(
      buildTestSlugFromMetadata(fallbackMetadata, {
        fileNameStyle: 'test',
        fileNameOverflowStrategy: 'truncate',
        maxSlugLength: 60,
        sessionIdToken: '',
        sessionIdFullToken: '',
      }),
    ).toMatch(/^checkout_spec_[a-f0-9]{8}_retry3$/u)

    const compactWithSession = buildTestSlugFromMetadata(metadata, {
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      maxSlugLength: 10,
      sessionIdToken: 'a',
      sessionIdFullToken: 'a',
    })
    expect(compactWithSession).toMatch(/^a_[a-f0-9]{8}$/u)

    const trimmedSession = buildTestSlugFromMetadata(metadata, {
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      maxSlugLength: 13,
      sessionIdToken: 'verylongsession',
      sessionIdFullToken: 'verylongsession',
    })
    expect(trimmedSession).toMatch(/^very_[a-f0-9]{8}$/u)

    const compact = buildTestSlugFromMetadata(metadata, {
      fileNameStyle: 'test',
      fileNameOverflowStrategy: 'truncate',
      maxSlugLength: 8,
      sessionIdToken: 'verylongsession',
      sessionIdFullToken: 'verylongsession-full',
    })
    expect(compact).toMatch(/^[a-f0-9]{8}$/u)

    expect(
      buildTestSlugFromMetadata(metadata, {
        fileNameStyle: 'session-full',
        fileNameOverflowStrategy: 'truncate',
        maxSlugLength: 40,
        sessionIdToken: 'short-session',
        sessionIdFullToken: '',
      }),
    ).toBe('short_session_retry3')
    expect(
      buildTestSlugFromMetadata(metadata, {
        fileNameStyle: 'session-full',
        fileNameOverflowStrategy: 'truncate',
        maxSlugLength: 40,
        sessionIdToken: '',
        sessionIdFullToken: '',
      }),
    ).toBe('session_retry3')
    expect(
      buildTestSlugFromMetadata(metadata, {
        fileNameStyle: 'session',
        fileNameOverflowStrategy: 'truncate',
        maxSlugLength: 40,
        sessionIdToken: '',
        sessionIdFullToken: '',
      }),
    ).toBe('session_retry3')

    expect(
      buildTestSlugFromMetadata(metadata, {
        fileNameStyle: 'test',
        fileNameOverflowStrategy: 'truncate',
        maxSlugLength: 8,
        sessionIdToken: '',
        sessionIdFullToken: '',
      }),
    ).toMatch(/^[a-f0-9]{8}$/u)
  })

  it('falls back to stable metadata when framework records are sparse', () => {
    expect(collectSlugMetadata({} as never, null)).toMatchObject({
      retryToken: '',
      fileToken: 'spec',
      testNameToken: 'spec',
      hashInput: '0',
    })

    expect(
      collectSlugMetadata(
        {
          file: '   ',
          uri: 'file://tests/features/checkout.feature?line=12',
          title: '!!!',
          description: 'records a checkout',
        } as never,
        undefined,
      ),
    ).toMatchObject({
      fileToken: 'checkout',
      testNameToken: 'records_a_checkout',
    })
    expect(
      collectSlugMetadata(
        {
          file: 'tests/specs/checkout.spec.ts',
          title: '!!!',
        } as never,
        undefined,
      ).testNameToken,
    ).toBe('checkout_spec')
  })

  it('appends run suffixes while keeping the slug within the maximum length', () => {
    const slugUsageCount = new Map<string, number>()

    expect(reserveUniqueSlug('very-long-slug-name', 14, slugUsageCount)).toBe(
      'very_long_slug',
    )
    expect(reserveUniqueSlug('very-long-slug-name', 14, slugUsageCount)).toBe(
      'very_long_run2',
    )

    const roomyUsage = new Map<string, number>()
    expect(reserveUniqueSlug('short', 20, roomyUsage)).toBe('short')
    expect(reserveUniqueSlug('short', 20, roomyUsage)).toBe('short_run2')

    const fallbackUsage = new Map<string, number>()
    expect(reserveUniqueSlug('!!!', 20, fallbackUsage)).toBe('test')
  })
})
