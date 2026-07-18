import { afterEach, describe, expect, it } from 'vitest'
import {
  type FixtureServer,
  startFixtureServer,
} from '../fixtures/fixture-server.js'

let fixtureServer: FixtureServer | undefined

afterEach(async () => {
  await fixtureServer?.close()
  fixtureServer = undefined
})

describe('deterministic E2E fixture server', () => {
  it('serves local static and animated fixtures', async () => {
    fixtureServer = await startFixtureServer()

    const [staticResponse, animationResponse] = await Promise.all([
      fetch(`${fixtureServer.baseUrl}/static`),
      fetch(`${fixtureServer.baseUrl}/animation`),
    ])

    await expect(staticResponse.text()).resolves.toContain(
      'This page is intentionally static.',
    )
    await expect(animationResponse.text()).resolves.toContain(
      'Animation running',
    )
  })

  it('serves a genuinely cross-origin iframe target', async () => {
    fixtureServer = await startFixtureServer()
    expect(fixtureServer.crossOriginUrl).not.toBe(fixtureServer.baseUrl)

    const hostResponse = await fetch(
      `${fixtureServer.baseUrl}/cross-origin-iframe`,
    )
    const frameResponse = await fetch(
      `${fixtureServer.crossOriginUrl}/frame-content`,
    )

    await expect(hostResponse.text()).resolves.toContain(
      `${fixtureServer.crossOriginUrl}/frame-content`,
    )
    await expect(frameResponse.text()).resolves.toContain(
      'Cross-origin fixture content',
    )
  })

  it('returns a deterministic 404 for unknown routes', async () => {
    fixtureServer = await startFixtureServer()
    const response = await fetch(`${fixtureServer.baseUrl}/missing`)

    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('Fixture route not found')
  })
})
