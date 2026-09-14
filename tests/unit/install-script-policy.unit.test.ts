import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describePendingInstallScripts,
  parsePendingInstallScripts,
} from '../../scripts/check-install-scripts.js'

const workflowDirectory = '.github/workflows'

const readWorkflow = (name: string): Promise<string> => {
  return fs.readFile(path.join(workflowDirectory, name), 'utf8')
}

// Top-level jobs are the two-space-indented keys under `jobs:`.
const splitJobs = (workflow: string): Map<string, string> => {
  const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'))
  const jobs = new Map<string, string>()
  const matches = [...jobsSection.matchAll(/^ {2}([\w-]+):$/gmu)]
  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0
    const end = matches[index + 1]?.index ?? jobsSection.length
    jobs.set(match[1] ?? '', jobsSection.slice(start, end))
  }
  return jobs
}

const readFoldedRun = (workflow: string, stepName: string): string => {
  const step = new RegExp(
    `- name: ${stepName}\\n(?: {8}if: .+\\n)? {8}run: >-\\n((?: {10}.+\\n)+)`,
    'u',
  ).exec(workflow)
  return (step?.[1] ?? '').replace(/\s+/gu, ' ').trim()
}

const readMinimumPeers = (workflow: string): string => {
  const block = /MINIMUM_SUPPORTED_PEERS: >-\n((?: {4}.+\n)+)/u.exec(workflow)
  return (block?.[1] ?? '').replace(/\s+/gu, ' ').trim()
}

describe('install script approval check', () => {
  it('lists every pending installed version from npm output', () => {
    const pending = parsePendingInstallScripts(
      JSON.stringify({
        allowScripts: [
          {
            name: 'esbuild',
            changes: [
              { key: 'esbuild@0.28.2', change: 'pending' },
              { key: 'esbuild@0.29.0', change: 'pending' },
            ],
          },
          {
            name: '@scope/native',
            changes: [{ key: '@scope/native@1.0.0', change: 'pending' }],
          },
        ],
      }),
    )

    expect(pending).toEqual([
      { name: 'esbuild', key: 'esbuild@0.28.2' },
      { name: 'esbuild', key: 'esbuild@0.29.0' },
      { name: '@scope/native', key: '@scope/native@1.0.0' },
    ])
  })

  it('treats an empty listing as fully reviewed', () => {
    expect(parsePendingInstallScripts('{"allowScripts":[]}')).toEqual([])
  })

  it('ignores entries npm does not report as pending', () => {
    expect(
      parsePendingInstallScripts(
        JSON.stringify({
          allowScripts: [
            {
              name: 'esbuild',
              changes: [{ key: 'esbuild@0.28.2', change: 'added' }, null],
            },
          ],
        }),
      ),
    ).toEqual([])
  })

  it.each([
    ['a missing list', '{}'],
    ['a non-object result', '[]'],
    ['an entry without a name', '{"allowScripts":[{"changes":[]}]}'],
    ['an entry without changes', '{"allowScripts":[{"name":"esbuild"}]}'],
  ])('rejects %s rather than passing silently', (_label, output) => {
    expect(() => parsePendingInstallScripts(output)).toThrow(TypeError)
  })

  it('suggests a name-only deny and an exact-version approval', () => {
    const report = describePendingInstallScripts([
      { name: 'esbuild', key: 'esbuild@0.28.2' },
      { name: 'esbuild', key: 'esbuild@0.29.0' },
    ])

    expect(report).toContain('2 installed packages have install scripts')
    expect(report).toContain('  "esbuild": false')
    expect(report.match(/"esbuild": false/gu)).toHaveLength(1)
    expect(report).toContain('  "esbuild@0.29.0": true')
    expect(report).not.toMatch(/"esbuild": true/u)
    expect(
      describePendingInstallScripts([
        { name: 'esbuild', key: 'esbuild@0.28.2' },
      ]),
    ).toContain('1 installed package has install scripts')
  })
})

describe('install script policy in CI', () => {
  it('keeps the repository min-release-age policy in every workflow', async () => {
    const [npmConfig, names] = await Promise.all([
      fs.readFile('.npmrc', 'utf8'),
      fs.readdir(workflowDirectory),
    ])
    expect(npmConfig).toMatch(/^min-release-age=2$/mu)
    for (const name of names) {
      // Validation once overrode the age with 0, so a same-day upstream release
      // changed results between jobs and reruns.
      expect(await readWorkflow(name), name).not.toContain('--min-release-age')
    }
  })

  it('checks approvals after every lock-free install and before any rebuild', async () => {
    const validation = await readWorkflow('release-validation.yaml')
    const lockFreeJobs = [...splitJobs(validation)].filter(([, job]) =>
      job.includes('npm install --no-save'),
    )

    expect(lockFreeJobs.map(([name]) => name)).toEqual([
      'core',
      'chrome-protocol',
      'support-floor',
      'frameworks',
      'edge',
    ])
    for (const [name, job] of lockFreeJobs) {
      const lastInstall = job.lastIndexOf('npm install --no-save')
      const check = job.indexOf('npm run check:install-scripts')
      const rebuild = job.indexOf('npm rebuild')
      expect(check, name).toBeGreaterThan(lastInstall)
      expect(check, name).toBeLessThan(rebuild)
    }
  })

  it('checks lockfile approvals in pull requests before other verification', async () => {
    const verify = splitJobs(
      await readWorkflow('pull-request-checks.yaml'),
    ).get('verify')

    const install = verify?.indexOf('npm ci --ignore-scripts') ?? -1
    const check = verify?.indexOf('npm run check:install-scripts') ?? -1
    expect(install).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(install)
    expect(check).toBeLessThan(verify?.indexOf('npm run lint') ?? -1)
  })

  it('resolves exactly the validated stacks in the weekly drift check', async () => {
    const [validation, drift] = await Promise.all([
      readWorkflow('release-validation.yaml'),
      readWorkflow('install-script-drift.yaml'),
    ])

    expect(drift).toMatch(/^ {2}schedule:\n {4}- cron: /mu)
    expect(drift).toContain('  workflow_dispatch:')
    expect(drift).toMatch(/^permissions:\n {2}contents: read$/mu)
    expect(readMinimumPeers(drift)).not.toBe('')
    expect(readMinimumPeers(drift)).toBe(readMinimumPeers(validation))
    const latest = readFoldedRun(drift, 'Install Latest Supported Peers')
    expect(latest).toContain('webdriverio@9')
    expect(latest).toBe(
      readFoldedRun(validation, 'Install Latest Supported Peers'),
    )
    expect(drift).toContain('run: corepack npm run check:install-scripts')
    // The drift check reports; it never runs, approves, or bypasses scripts.
    expect(drift).not.toMatch(
      /npm rebuild|approve-scripts|deny-scripts|--dangerously-allow-all-scripts/u,
    )
    for (const install of drift.match(/npm (?:ci|install)[^\n]*/gu) ?? []) {
      expect(install).toContain('--ignore-scripts')
    }
  })
})
