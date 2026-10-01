import { createServer } from 'node:http'

export const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Recorder pipeline fixture</title><style>
html,body { margin:0; width:100%; height:100%; background:#00e020; overflow:hidden }
#label { position:absolute; top:10px; left:10px; padding:8px; background:white; color:black }
#tile { width:120px; height:120px; background:blue; position:absolute; top:40%; left:0 }
body.animated { animation:color 1s steps(1,end) infinite }
body.animated #tile { animation:travel 2s linear infinite alternate }
@keyframes color { 0%,100% { background:#00e020 } 50% { background:#e02000 } }
@keyframes travel { to { transform:translateX(1600px) rotate(360deg) } }
</style><body><div id="label">Ready</div><div id="tile"></div><script>
if (location.pathname === '/animated') { document.body.classList.add('animated') }
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
