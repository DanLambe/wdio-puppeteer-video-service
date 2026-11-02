import { createServer } from 'node:http'
import {
  MARKER_CELL_PX,
  MARKER_CELLS,
  MARKER_INSET_PX,
  MARKER_VALUE_BITS,
} from '../../../tests/utils/action-markers.js'

export const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Recorder pipeline fixture</title><style>
html,body { margin:0; width:100%; height:100%; background:#00e020; overflow:hidden }
#label { position:absolute; top:10px; left:10px; padding:8px; background:white; color:black }
#tile { width:120px; height:120px; background:blue; position:absolute; top:40%; left:0 }
body.animated { animation:color 1s steps(1,end) infinite }
body.animated #tile { animation:travel 2s linear infinite alternate }
@keyframes color { 0%,100% { background:#00e020 } 50% { background:#e02000 } }
@keyframes travel { to { transform:translateX(1600px) rotate(360deg) } }
#marker { position:fixed; top:${MARKER_INSET_PX}px; right:${MARKER_INSET_PX}px; display:flex; z-index:1 }
#marker i { display:block; width:${MARKER_CELL_PX}px; height:${MARKER_CELL_PX}px }
</style><body><div id="label">Ready</div><div id="tile"></div><script>
if (location.pathname === '/animated') { document.body.classList.add('animated') }
// ?tab=N draws the tab's identity and click count for the media oracle.
const tab = new URLSearchParams(location.search).get('tab')
if (tab) {
  const strip = document.createElement('div')
  strip.id = 'marker'
  const cells = Array.from({ length: ${MARKER_CELLS} }, () => strip.appendChild(document.createElement('i')))
  document.body.append(strip)
  let clicks = 0
  const paint = () => {
    const bits = Array.from({ length: ${MARKER_VALUE_BITS} }, (_, bit) => ((clicks >> (${MARKER_VALUE_BITS - 1} - bit)) & 1) === 1)
    const dark = [true, false, tab === '1', ...bits, false]
    cells.forEach((cell, index) => { cell.style.background = dark[index] ? '#000' : '#fff' })
  }
  paint()
  document.getElementById('label').addEventListener('click', () => { clicks += 1; paint() })
}
</script></body></html>`

export const startPipelineFixture = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-store',
    })
    response.end(fixtureHtml)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No fixture listener address')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
