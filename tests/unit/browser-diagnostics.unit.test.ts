import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

interface DiagnosticUpload {
  readonly patterns: readonly string[]
  readonly includeHiddenFiles: boolean
}

const readDiagnosticUpload = async (
  stepName: string,
): Promise<DiagnosticUpload> => {
  const action = await fs.readFile(
    '.github/actions/collect-browser-diagnostics/action.yml',
    'utf8',
  )
  const step = action
    .split(`    - name: ${stepName}`)[1]
    ?.split('    - name: ')[0]
  expect(step).toBeDefined()
  const block = step ?? ''
  const patterns = [...block.matchAll(/^ {10}(\S.*)$/gmu)].map((match) =>
    (match[1] ?? '').trim(),
  )
  expect(patterns.length).toBeGreaterThan(0)
  return {
    patterns,
    includeHiddenFiles: block.includes('include-hidden-files: true'),
  }
}

const selectsFile = (upload: DiagnosticUpload, filePath: string): boolean => {
  const isHidden = filePath.split('/').some((part) => part.startsWith('.'))
  return (
    (upload.includeHiddenFiles || !isHidden) &&
    upload.patterns.some((pattern) => path.posix.matchesGlob(filePath, pattern))
  )
}

describe('browser failure diagnostics', () => {
  it('selects ordinary diagnostics without exposing hidden files or video', async () => {
    const upload = await readDiagnosticUpload('Upload Browser Diagnostics')
    for (const fileName of [
      'manifest.json',
      'video-report.html',
      'worker.log',
    ]) {
      expect(selectsFile(upload, `tests/results/multipart/${fileName}`)).toBe(
        true,
      )
    }
    for (const fileName of ['.env.json', 'capture.mp4', 'capture.webm']) {
      expect(selectsFile(upload, `tests/results/multipart/${fileName}`)).toBe(
        false,
      )
    }
    expect(selectsFile(upload, 'tests/results/.private/settings.json')).toBe(
      false,
    )
  })

  it('includes only generated worker journals in the hidden-file upload', async () => {
    const upload = await readDiagnosticUpload('Upload Worker Journals')
    const journalDirectory =
      'tests/results/multipart/.wdio-video-manifest/run-123/journals'
    expect(selectsFile(upload, `${journalDirectory}/0-0-123.jsonl`)).toBe(true)

    for (const filePath of [
      `${journalDirectory}/capture.mp4`,
      `${journalDirectory}/capture.webm`,
      'tests/results/multipart/worker.jsonl',
      'tests/results/multipart/.private/worker.jsonl',
      'tests/results/multipart/.wdio-video-manifest/run-123/settings.json',
      'outside/.wdio-video-manifest/run-123/journals/worker.jsonl',
    ]) {
      expect(selectsFile(upload, filePath)).toBe(false)
    }
  })

  it('keeps service warnings visible in the otherwise quiet main E2E config', async () => {
    const config = await fs.readFile('tests/wdio.conf.ts', 'utf8')
    expect(config).toContain("logLevel: 'error'")
    expect(config.split('videoServiceModulePath,')[1]).toContain(
      "logLevel: 'warn'",
    )
  })
})
