import { describe, expect, it } from 'vitest'
import type { ManifestEntryV1, ManifestTab } from '../../src/manifest.js'
import {
  findTabProvenanceProblems,
  readEntryTabs,
  toTabSteps,
} from '../utils/tab-provenance.js'

const tab = (
  ordinal: number,
  reason: ManifestTab['reason'],
  contextHash = `hash-${ordinal.toString()}`,
): ManifestTab => ({ ordinal, reason, contextHash })

const entry = (capture: Partial<ManifestEntryV1['capture']>): ManifestEntryV1 =>
  ({
    id: 'entry',
    test: { name: 'uses tabs' },
    capture: { decision: 'recorded', segments: [], ...capture },
  }) as unknown as ManifestEntryV1

const segment = (part: number, segmentTab?: ManifestTab) => ({
  path: `t_part${part.toString()}.webm`,
  mimeType: 'video/webm' as const,
  size: 1,
  ...(segmentTab ? { tab: segmentTab } : {}),
})

const mergedFile = (tabs?: ManifestTab[]) => ({
  path: 't.webm',
  mimeType: 'video/webm' as const,
  size: 1,
  ...(tabs ? { tabs } : {}),
})

describe('tab provenance checks', () => {
  it('reads segment tabs in part order, or a final file’s tabs', () => {
    const segments = entry({
      segments: [segment(10, tab(2, 'command')), segment(2, tab(1, 'start'))],
    })
    expect(toTabSteps(readEntryTabs(segments))).toEqual([
      [1, 'start'],
      [2, 'command'],
    ])

    const merged = entry({
      segments: [],
      final: { path: 't.webm', mimeType: 'video/webm', size: 1 },
    })
    expect(readEntryTabs(merged)).toEqual([])
    expect(toTabSteps([undefined])).toEqual([undefined])

    const retained = entry({
      segments: [
        segment(1, tab(1, 'start')),
        segment(2, tab(2, 'command')),
        mergedFile([tab(1, 'start'), tab(2, 'command')]),
      ],
    })
    expect(toTabSteps(readEntryTabs(retained))).toEqual([
      [1, 'start'],
      [2, 'command'],
    ])
  })

  it('accepts a consistent recording and ignores unrecorded entries', () => {
    expect(
      findTabProvenanceProblems(
        entry({
          segments: [
            segment(1, tab(1, 'start')),
            segment(2, tab(2, 'command')),
            segment(3, tab(1, 'tab-closed')),
          ],
        }),
      ),
    ).toEqual([])
    expect(
      findTabProvenanceProblems(
        entry({ decision: 'discarded', segments: [segment(1)] }),
      ),
    ).toEqual([])
    // An empty first part is discarded, so the history can start later.
    expect(
      findTabProvenanceProblems(
        entry({
          segments: [segment(2, tab(2, 'command'))],
          final: { ...segment(2), tabs: [tab(2, 'command')] },
        }),
      ),
    ).toEqual([])
    expect(
      findTabProvenanceProblems(
        entry({
          segments: [
            segment(1, tab(1, 'start')),
            segment(2, tab(2, 'command')),
            mergedFile([tab(1, 'start'), tab(2, 'command')]),
          ],
        }),
      ),
    ).toEqual([])
  })

  it('reports missing tabs and inconsistent numbering', () => {
    expect(
      findTabProvenanceProblems(
        entry({ segments: [segment(1, tab(1, 'start')), segment(2)] }),
      ),
    ).toEqual(['"uses tabs" has a part without its tab: t_part2.webm'])
    expect(
      findTabProvenanceProblems(
        entry({
          segments: [mergedFile()],
          final: { path: 't.webm', mimeType: 'video/webm', size: 1 },
        }),
      ),
    ).toEqual([
      '"uses tabs" has a merged file without its tabs',
      '"uses tabs" has a final file without its tabs',
    ])
    expect(
      findTabProvenanceProblems(
        entry({
          segments: [
            segment(1, tab(1, 'start', 'a')),
            segment(2, tab(1, 'command', 'b')),
          ],
        }),
      ),
    ).toEqual(['"uses tabs" numbers its tabs inconsistently'])
  })
})
