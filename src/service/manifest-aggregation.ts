import type { ManifestRunV1, VideoManifestV1 } from '../manifest.js'
import type { ManifestRunContext } from './manifest-context.js'
import { parseManifestJournals } from './manifest-journal.js'
import { persistManifestRun } from './manifest-persistence.js'

export const aggregateManifestRun = async (
  context: ManifestRunContext,
  exitCode: number,
): Promise<VideoManifestV1> => {
  const parsed = await parseManifestJournals(context)
  const completedAt = new Date().toISOString()
  const run: ManifestRunV1 = {
    id: context.runId,
    startedAt: context.startedAt,
    completedAt,
    exitCode,
    tools: { ...context.tools, ...parsed.tools },
    entries: parsed.entries,
    ...(parsed.diagnostics.length > 0
      ? { diagnostics: parsed.diagnostics }
      : {}),
  }
  return persistManifestRun(context, run, completedAt)
}
