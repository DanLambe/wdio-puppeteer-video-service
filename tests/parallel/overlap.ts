const started = new Set<string>()

/**
 * Waits until every parallel test has started. Run one after another, the
 * first would wait for a test that cannot start, so passing proves overlap.
 */
export const awaitParallelPeers = async (
  name: string,
  peers = 2,
): Promise<void> => {
  started.add(name)
  const deadline = Date.now() + 15_000
  while (started.size < peers) {
    if (Date.now() > deadline) {
      throw new Error(`Only ${[...started].join(', ')} started in parallel`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
