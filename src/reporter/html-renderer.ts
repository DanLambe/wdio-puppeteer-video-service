import { createHash } from 'node:crypto'
import type { ReportItem, ReportMedia, ReportModel } from './report-model.js'
import type {
  ReporterDiagnostic,
  ReporterErrorDetails,
  ReporterTestStatus,
} from './types.js'

export const renderStaticVideoReport = (model: ReportModel): string => {
  const statuses: ReporterTestStatus[] = [
    'passed',
    'failed',
    'skipped',
    'pending',
    'unknown',
  ]
  const specs = uniqueSorted(model.items.map((item) => item.spec))
  const browsers = uniqueSorted(model.items.map((item) => item.browser))
  const cards = model.items.map(renderReportItem).join('\n')
  const diagnosticMarkup = renderDiagnostics(model.diagnostics)
  const summary = statuses
    .map((status) => {
      const count = model.items.filter((item) => item.status === status).length
      return `<span class="summary summary-${status}">${escapeHtml(status)}: ${count.toString()}</span>`
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; media-src 'self' data: blob:; style-src '${REPORT_STYLE_HASH}'; script-src '${REPORT_SCRIPT_HASH}'">
  <title>WebdriverIO Video Report</title>
  <style>${REPORT_STYLES}</style>
</head>
<body>
  <header>
    <div><p class="eyebrow">wdio-puppeteer-video-service</p><h1>Video Report</h1></div>
    <div class="run-meta">Run ${escapeHtml(model.runId)}<br>${escapeHtml(model.generatedAt)}</div>
  </header>
  <section class="summaries" aria-label="Outcome summary">${summary}</section>
  ${diagnosticMarkup}
  <section class="filters" aria-label="Report filters">
    ${renderSelect('status-filter', 'Status', ['all', ...statuses])}
    ${renderSelect('spec-filter', 'Spec', ['all', ...specs])}
    ${renderSelect('browser-filter', 'Browser', ['all', ...browsers])}
    ${renderSelect('retry-filter', 'Attempt', ['all', 'first attempt', 'retried'])}
  </section>
  <main id="results">${cards || '<p class="empty">No test outcomes were captured.</p>'}</main>
  <p id="empty-filter" class="empty" hidden>No outcomes match the selected filters.</p>
  <script>${REPORT_SCRIPT}</script>
</body>
</html>
`
}

const renderReportItem = (item: ReportItem): string => {
  const errorMarkup = item.errors?.length
    ? `<details><summary>Error details</summary>${item.errors
        .map((error) => `<pre>${escapeHtml(formatError(error))}</pre>`)
        .join('')}</details>`
    : ''
  const pendingMarkup = item.pendingReason
    ? `<p class="diagnostic-line">${escapeHtml(item.pendingReason)}</p>`
    : ''
  const captureMarkup = [
    item.captureDecision
      ? `capture: ${item.captureDecision}`
      : 'no manifest match',
    item.processingOutcome ? `processing: ${item.processingOutcome}` : '',
    item.captureReason ?? '',
  ]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ')
  const mediaMarkup = item.media.length
    ? item.media.map(renderMedia).join('')
    : '<p class="no-video">No video retained for this outcome.</p>'
  return `<article class="result-card" data-status="${escapeHtml(item.status)}" data-spec="${escapeHtml(item.spec)}" data-browser="${escapeHtml(item.browser)}" data-retried="${item.retried ? 'true' : 'false'}">
    <div class="result-heading"><span class="status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span><div><h2>${escapeHtml(item.testName)}</h2>${renderTestContext(item)}</div></div>
    <dl><div><dt>Spec</dt><dd>${escapeHtml(item.spec)}</dd></div><div><dt>Browser</dt><dd>${escapeHtml(item.browser)}</dd></div><div><dt>Attempt</dt><dd>${item.attempt.toString()}</dd></div><div><dt>Duration</dt><dd>${item.durationMs.toString()} ms</dd></div></dl>
    <p class="diagnostic-line">${captureMarkup}</p>${pendingMarkup}${errorMarkup}
    <div class="media-grid">${mediaMarkup}</div>
  </article>`
}

const renderTestContext = (item: ReportItem): string => {
  const values = [item.containerName, item.fullName].filter(
    (value): value is string => !!value,
  )
  return values.length > 0 ? `<p>${escapeHtml(values.join(' · '))}</p>` : ''
}

const renderMedia = (media: ReportMedia): string => {
  const dimensions =
    media.width && media.height
      ? ` · ${media.width.toString()}×${media.height.toString()}`
      : ''
  if (!media.available) {
    return `<div class="missing-media"><strong>Missing media</strong><br>${escapeHtml(media.path)}</div>`
  }
  return `<figure><video controls preload="metadata"><source src="${escapeHtml(media.href)}" type="${escapeHtml(media.mimeType)}"></video><figcaption><a href="${escapeHtml(media.href)}">${escapeHtml(media.path)}</a> · ${formatBytes(media.size)}${dimensions}</figcaption></figure>`
}

const renderDiagnostics = (diagnostics: ReporterDiagnostic[]): string => {
  if (diagnostics.length === 0) {
    return ''
  }
  return `<section class="diagnostics" aria-label="Report diagnostics"><h2>Diagnostics</h2><ul>${diagnostics
    .map(
      (diagnostic) =>
        `<li><code>${escapeHtml(diagnostic.code)}</code> ${escapeHtml(diagnostic.message)}</li>`,
    )
    .join('')}</ul></section>`
}

const renderSelect = (
  id: string,
  label: string,
  values: readonly string[],
): string => {
  const options = values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`,
    )
    .join('')
  return `<label for="${escapeHtml(id)}">${escapeHtml(label)}<select id="${escapeHtml(id)}">${options}</select></label>`
}

const uniqueSorted = (values: string[]): string[] => {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

const formatError = (error: ReporterErrorDetails): string => {
  if (!error.stack || error.stack.includes(error.message)) {
    return error.stack ?? error.message
  }
  return `${error.message}\n${error.stack}`
}

const formatBytes = (value: number): string => {
  if (value < 1024) {
    return `${value.toString()} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

const escapeHtml = (value: string): string => {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const REPORT_STYLES = `
:root{color-scheme:dark;--bg:#09111f;--panel:#111c2f;--line:#263650;--text:#eef4ff;--muted:#9fb0c9;--pass:#36d399;--fail:#fb7185;--skip:#fbbf24;--pending:#a78bfa;--unknown:#94a3b8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#182743,var(--bg) 42rem);color:var(--text);font:14px/1.5 system-ui,sans-serif}header,.summaries,.filters,.diagnostics,main,#empty-filter{width:min(1180px,calc(100% - 2rem));margin-inline:auto}header{display:flex;justify-content:space-between;gap:2rem;padding:3rem 0 1.5rem}.eyebrow{color:#78a9ff;letter-spacing:.12em;text-transform:uppercase;margin:0}h1{font-size:2.6rem;margin:.2rem 0}h2{margin:0;font-size:1.05rem}.run-meta{text-align:right;color:var(--muted);overflow-wrap:anywhere}.summaries{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}.summary,.status{border:1px solid var(--line);border-radius:999px;padding:.25rem .65rem;text-transform:capitalize}.summary-passed,.status-passed{color:var(--pass)}.summary-failed,.status-failed{color:var(--fail)}.summary-skipped,.status-skipped{color:var(--skip)}.summary-pending,.status-pending{color:var(--pending)}.summary-unknown,.status-unknown{color:var(--unknown)}.filters{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;padding:1rem;background:rgba(9,17,31,.94);border:1px solid var(--line);border-radius:14px;backdrop-filter:blur(12px)}label{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}select{display:block;width:100%;margin-top:.35rem;padding:.55rem;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)}main{display:grid;gap:1rem;padding:1rem 0 3rem}.result-card,.diagnostics{background:rgba(17,28,47,.93);border:1px solid var(--line);border-radius:14px;padding:1rem}.result-heading{display:flex;align-items:flex-start;gap:.8rem}.result-heading p,.diagnostic-line{color:var(--muted);margin:.2rem 0}dl{display:grid;grid-template-columns:2fr 1fr .5fr .5fr;gap:.75rem;margin:1rem 0}dl div{min-width:0}dt{color:var(--muted);font-size:.75rem;text-transform:uppercase}dd{margin:0;overflow-wrap:anywhere}.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:1rem;margin-top:1rem}figure{margin:0}video{display:block;width:100%;max-height:480px;background:#000;border-radius:9px}figcaption{margin-top:.35rem;color:var(--muted);overflow-wrap:anywhere}a{color:#8eb9ff}.no-video,.missing-media,.empty{color:var(--muted);padding:1rem;border:1px dashed var(--line);border-radius:9px}.diagnostics{margin-bottom:1rem;border-color:#8a6423}.diagnostics h2{color:var(--skip)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080d17;padding:1rem;border-radius:8px;color:#ffd5dc}@media(max-width:720px){header{display:block}.run-meta{text-align:left}.filters,dl{grid-template-columns:1fr 1fr}}@media(max-width:480px){.filters,dl{grid-template-columns:1fr}}
`

const REPORT_SCRIPT = `
const filters={status:document.querySelector('#status-filter'),spec:document.querySelector('#spec-filter'),browser:document.querySelector('#browser-filter'),retry:document.querySelector('#retry-filter')};const cards=[...document.querySelectorAll('.result-card')];const empty=document.querySelector('#empty-filter');const apply=()=>{let visible=0;for(const card of cards){const retryValue=card.dataset.retried==='true'?'retried':'first attempt';const show=(filters.status.value==='all'||card.dataset.status===filters.status.value)&&(filters.spec.value==='all'||card.dataset.spec===filters.spec.value)&&(filters.browser.value==='all'||card.dataset.browser===filters.browser.value)&&(filters.retry.value==='all'||retryValue===filters.retry.value);card.hidden=!show;if(show)visible+=1}empty.hidden=visible!==0};for(const filter of Object.values(filters)){filter.addEventListener('change',apply)}apply();
`

// A nonce is only worth anything when it is unpredictable, and a static report
// generated once and read from disk has no per-request secret to derive one
// from. Hash the exact emitted text instead: the digest is reproducible, so the
// report stays byte-identical between runs, and it stops matching if either
// block is ever altered. Digests are computed from the constants above rather
// than copied in, so they cannot drift from what is rendered.
const createContentHash = (content: string): string => {
  return `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`
}

const REPORT_STYLE_HASH = createContentHash(REPORT_STYLES)
const REPORT_SCRIPT_HASH = createContentHash(REPORT_SCRIPT)
