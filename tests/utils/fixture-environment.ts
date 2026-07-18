export const requireFixtureBaseUrl = (): string => {
  const baseUrl = process.env.WDIO_FIXTURE_BASE_URL?.trim()
  if (!baseUrl) {
    throw new Error(
      'WDIO_FIXTURE_BASE_URL is required. Run E2E tests through the package scripts so the local fixture server is started.',
    )
  }
  return baseUrl
}
