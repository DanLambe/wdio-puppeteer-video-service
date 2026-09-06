import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// The workflow's tag preflight is shell, so a text assertion cannot show what it
// does with a real GitHub response. These tests extract the actual step body
// from the workflow and run it against a mocked `gh`, which is the only way to
// cover the difference between a tag that is absent and a lookup that failed.

const VALIDATED_SHA = '95c87d4b94c2e1ebf6e68652a95b18a1c76dc1d5'
const OTHER_SHA = '0868a1ef554abaf848f33fae0893e8b6db3ea98e'
const STEP_NAME = 'Require A Matching Release Tag'

// The response GitHub actually returns for an absent tag: `gh` exits non-zero
// and prints this body on stdout, not stderr.
const NOT_FOUND_BODY = JSON.stringify({
  message: 'Not Found',
  documentation_url: 'https://docs.github.com/rest/git/refs#get-a-reference',
  status: '404',
})
const RATE_LIMITED_BODY = JSON.stringify({
  message: 'API rate limit exceeded',
  status: '403',
})

// `bash` on a Windows host can resolve to WSL, which does not inherit the
// caller's environment, so probe for a shell that actually receives one rather
// than trusting that the command exists. A shell that cannot be driven skips
// these tests instead of passing them for the wrong reason.
const resolveBash = (): string | undefined => {
  const candidates = [
    ...(process.platform === 'win32'
      ? [String.raw`C:\Program Files\Git\bin\bash.exe`]
      : []),
    'bash',
  ]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-s'], {
      encoding: 'utf8',
      env: { ...process.env, PREFLIGHT_PROBE: 'ready' },
      input: 'printf %s "$PREFLIGHT_PROBE"',
    })
    if (probe.status === 0 && probe.stdout === 'ready') {
      return candidate
    }
  }
  return undefined
}

const bash = resolveBash()

const extractStepScript = async (): Promise<string> => {
  const workflow = await fs.readFile('.github/workflows/publish.yaml', 'utf8')
  const lines = workflow.split('\n')
  const stepIndex = lines.findIndex((line) =>
    line.includes(`name: ${STEP_NAME}`),
  )
  expect(stepIndex).toBeGreaterThan(-1)
  const runIndex = lines.findIndex(
    (line, index) => index > stepIndex && line.trimEnd().endsWith('run: |'),
  )
  expect(runIndex).toBeGreaterThan(-1)
  const indent = (lines[runIndex]?.match(/^ */)?.[0].length ?? 0) + 2
  const body: string[] = []
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== '' && (line.match(/^ */)?.[0].length ?? 0) < indent) {
      break
    }
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

interface MockResponses {
  readonly referenceBody: string
  readonly referenceExit: number
  readonly annotatedBody?: string
  readonly annotatedExit?: number
}

const temporaryDirs: string[] = []

afterAll(async () => {
  await Promise.all(
    temporaryDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})

const runPreflight = async (
  responses: MockResponses,
): Promise<{ status: number; output: string }> => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-preflight-'))
  temporaryDirs.push(workspace)
  const binDir = path.join(workspace, 'bin')
  await fs.mkdir(binDir)
  await fs.writeFile(
    path.join(binDir, 'gh'),
    [
      '#!/usr/bin/env bash',
      'if [[ "$*" == *"git/ref/tags/"* ]]; then',
      '  printf %s "$MOCK_REFERENCE_BODY"',
      '  exit "$MOCK_REFERENCE_EXIT"',
      'fi',
      'if [[ "$*" == *"git/tags/"* ]]; then',
      '  printf %s "$MOCK_ANNOTATED_BODY"',
      '  exit "$MOCK_ANNOTATED_EXIT"',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // Feed the script on stdin so no Windows path has to survive translation
  // into the shell.
  const result = spawnSync(bash as string, ['-s'], {
    encoding: 'utf8',
    input: await extractStepScript(),
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'DanLambe/wdio-puppeteer-video-service',
      GITHUB_SHA: VALIDATED_SHA,
      MOCK_ANNOTATED_BODY: responses.annotatedBody ?? '',
      MOCK_ANNOTATED_EXIT: String(responses.annotatedExit ?? 0),
      MOCK_REFERENCE_BODY: responses.referenceBody,
      MOCK_REFERENCE_EXIT: String(responses.referenceExit),
      PACKAGE_VERSION: '1.0.0-rc.2',
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  })
  return {
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    status: result.status ?? -1,
  }
}

const reference = (type: string, sha: string): string =>
  JSON.stringify({ object: { sha, type } })

describe.runIf(bash !== undefined)('release tag preflight', () => {
  it('continues when GitHub confirms the tag is absent', async () => {
    const result = await runPreflight({
      referenceBody: NOT_FOUND_BODY,
      referenceExit: 1,
    })

    expect(result.status).toBe(0)
    expect(result.output).toContain('does not exist yet')
  })

  it('stops when the lookup fails without confirming absence', async () => {
    // A transport failure produces no body at all. Treating that as proof the
    // tag is missing would skip the check entirely.
    const transport = await runPreflight({
      referenceBody: '',
      referenceExit: 1,
    })
    const rateLimited = await runPreflight({
      referenceBody: RATE_LIMITED_BODY,
      referenceExit: 1,
    })

    expect(transport.status).not.toBe(0)
    expect(transport.output).toContain('Could not determine whether tag')
    expect(rateLimited.status).not.toBe(0)
    expect(rateLimited.output).toContain('Could not determine whether tag')
  })

  it.each([
    { expected: 0, label: 'the validated commit', sha: VALIDATED_SHA },
    { expected: 1, label: 'another commit', sha: OTHER_SHA },
  ])('handles a lightweight tag at $label', async ({ expected, sha }) => {
    const result = await runPreflight({
      referenceBody: reference('commit', sha),
      referenceExit: 0,
    })

    expect(result.status).toBe(expected)
  })

  it.each([
    { expected: 0, label: 'the validated commit', sha: VALIDATED_SHA },
    { expected: 1, label: 'another commit', sha: OTHER_SHA },
  ])('dereferences an annotated tag to $label', async ({ expected, sha }) => {
    const result = await runPreflight({
      annotatedBody: JSON.stringify({ object: { sha, type: 'commit' } }),
      annotatedExit: 0,
      referenceBody: reference('tag', 'a'.repeat(40)),
      referenceExit: 0,
    })

    expect(result.status).toBe(expected)
  })

  it('stops on malformed or unresolvable responses', async () => {
    const malformed = await runPreflight({
      referenceBody: '{"unexpected":true}',
      referenceExit: 0,
    })
    const unresolvable = await runPreflight({
      annotatedBody: '',
      annotatedExit: 1,
      referenceBody: reference('tag', 'a'.repeat(40)),
      referenceExit: 0,
    })

    expect(malformed.status).not.toBe(0)
    expect(malformed.output).toContain('Unexpected reference payload')
    expect(unresolvable.status).not.toBe(0)
    expect(unresolvable.output).toContain('Could not resolve annotated tag')
  })
})
