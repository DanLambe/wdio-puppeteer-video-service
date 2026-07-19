import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

interface AllureAttachment {
  name: string
  source: string
  type: string
}

interface AllureResult {
  name?: string
  fullName?: string
  attachments?: unknown
  steps?: unknown
}

const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm'])

export const assertAllureVideoAttachments = async (options: {
  expectedTitles: readonly string[]
  resultsDir: string
  runLabel: string
}): Promise<void> => {
  const allureResultsDir = path.join(options.resultsDir, 'allure-results')
  const files = await fs.readdir(allureResultsDir)
  const resultFiles = files.filter((file) => file.endsWith('-result.json'))
  assert.ok(
    resultFiles.length > 0,
    `[${options.runLabel}] Expected generated Allure result JSON`,
  )

  const results = await Promise.all(
    resultFiles.map(
      async (file) =>
        JSON.parse(
          await fs.readFile(path.join(allureResultsDir, file), 'utf8'),
        ) as AllureResult,
    ),
  )
  const mediaFiles = await findMediaFiles(options.resultsDir, allureResultsDir)

  for (const expectedTitle of options.expectedTitles) {
    const result = results.find(
      (candidate) =>
        `${candidate.name ?? ''} ${candidate.fullName ?? ''}`.includes(
          expectedTitle,
        ) && collectVideoAttachments(candidate).length > 0,
    )
    assert.ok(
      result,
      `[${options.runLabel}] Missing Allure result for "${expectedTitle}"`,
    )

    const attachments = collectVideoAttachments(result)
    assert.ok(
      attachments.length > 0,
      `[${options.runLabel}] Missing Allure video attachment for "${expectedTitle}"`,
    )

    for (const attachment of attachments) {
      assert.ok(
        VIDEO_MIME_TYPES.has(attachment.type),
        `[${options.runLabel}] Unexpected Allure MIME type ${attachment.type}`,
      )
      assert.equal(path.basename(attachment.source), attachment.source)
      const attachmentBytes = await fs.readFile(
        path.join(allureResultsDir, attachment.source),
      )
      assert.ok(attachmentBytes.byteLength > 0)

      const originalName = attachment.name.split(': ').at(-1)
      const originalPath = originalName
        ? mediaFiles.get(originalName)
        : undefined
      assert.ok(
        originalPath,
        `[${options.runLabel}] Missing retained source for ${attachment.name}`,
      )
      const originalBytes = await fs.readFile(originalPath)
      assert.deepEqual(
        attachmentBytes,
        originalBytes,
        `[${options.runLabel}] Allure attachment bytes differ from ${originalName}`,
      )
    }
  }
}

const collectVideoAttachments = (value: unknown): AllureAttachment[] => {
  if (Array.isArray(value)) {
    return value.flatMap(collectVideoAttachments)
  }
  if (!isRecord(value)) {
    return []
  }

  const attachments = Array.isArray(value.attachments)
    ? value.attachments.filter(isVideoAttachment)
    : []
  const steps = Array.isArray(value.steps)
    ? value.steps.flatMap(collectVideoAttachments)
    : []
  return [...attachments, ...steps]
}

const isVideoAttachment = (value: unknown): value is AllureAttachment => {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.source === 'string' &&
    typeof value.type === 'string' &&
    VIDEO_MIME_TYPES.has(value.type)
  )
}

const findMediaFiles = async (
  rootDir: string,
  excludedDir: string,
): Promise<Map<string, string>> => {
  const media = new Map<string, string>()
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (path.resolve(entryPath) !== path.resolve(excludedDir)) {
          await visit(entryPath)
        }
        continue
      }
      if (VIDEO_MIME_TYPES.has(mimeTypeFor(entry.name))) {
        media.set(entry.name, entryPath)
      }
    }
  }
  await visit(rootDir)
  return media
}

const mimeTypeFor = (fileName: string): string => {
  const extension = path.extname(fileName).toLowerCase()
  if (extension === '.mp4') {
    return 'video/mp4'
  }
  if (extension === '.webm') {
    return 'video/webm'
  }
  return ''
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}
