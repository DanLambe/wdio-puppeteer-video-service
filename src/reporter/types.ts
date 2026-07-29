import type { Reporters } from '@wdio/types'

export const REPORTER_FRAGMENT_SCHEMA_VERSION = 1 as const
export const DEFAULT_REPORT_FILE_NAME = 'video-report.html'

export type ReporterTestStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'pending'
  | 'unknown'

export type WdioPuppeteerVideoReporterOptions = Partial<Reporters.Options> & {
  /** Name of the generated static report beneath the service output directory. */
  reportFileName?: string
}

export interface ReporterBrowserIdentity {
  name: string
  version?: string
}

export interface ReporterErrorDetails {
  message: string
  stack?: string
}

export interface ReporterTestOutcome {
  uid: string
  runId: string
  cid: string
  spec: string
  browser: ReporterBrowserIdentity
  test: {
    name: string
    fullName?: string
    parent?: string
    containerName?: string
  }
  attempt: number
  retried: boolean
  status: ReporterTestStatus
  durationMs: number
  pendingReason?: string
  errors?: ReporterErrorDetails[]
}

export interface ReporterFragmentV1 {
  schemaVersion: typeof REPORTER_FRAGMENT_SCHEMA_VERSION
  runId: string
  cid: string
  specs: string[]
  browser: ReporterBrowserIdentity
  reportFileName: string
  startedAt: string
  completedAt: string
  outcomes: ReporterTestOutcome[]
}

export interface ReporterDiagnostic {
  code:
    | 'invalid-reporter-fragment'
    | 'missing-manifest'
    | 'invalid-manifest'
    | 'manifest-diagnostic'
    | 'missing-manifest-run'
    | 'unmatched-test-outcome'
    | 'unmatched-manifest-entry'
    | 'missing-media-artifact'
  message: string
}
