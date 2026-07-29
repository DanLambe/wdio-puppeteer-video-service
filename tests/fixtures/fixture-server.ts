import { createServer, type Server, type ServerResponse } from 'node:http'

const FIXTURE_HOST = '127.0.0.1'

export interface FixtureServer {
  baseUrl: string
  crossOriginUrl: string
  close: () => Promise<void>
}

const html = (title: string, body: string, script = ''): string => {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; }
      main { max-width: 52rem; }
      nav { display: grid; gap: 0.5rem; max-width: 24rem; }
      button, a { font: inherit; }
    </style>
  </head>
  <body>
    <main>${body}</main>
    ${script}
  </body>
</html>`
}

const sendHtml = (response: ServerResponse, content: string): void => {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  })
  response.end(content)
}

const sendNotFound = (response: ServerResponse): void => {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Fixture route not found')
}

const listen = async (server: Server): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }

    server.once('error', onError)
    server.listen(0, FIXTURE_HOST, () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Fixture server did not expose a TCP address'))
        return
      }

      resolve(`http://${FIXTURE_HOST}:${address.port.toString()}`)
    })
  })
}

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

const createCrossOriginServer = (): Server => {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://fixture.invalid')
      .pathname
    if (pathname !== '/frame-content') {
      sendNotFound(response)
      return
    }

    sendHtml(
      response,
      html(
        'Cross-origin frame',
        '<h1 id="cross-origin-content">Cross-origin fixture content</h1>',
      ),
    )
  })
}

const createPrimaryServer = (crossOriginUrl: string): Server => {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://fixture.invalid')
      .pathname

    switch (pathname) {
      case '/':
        sendHtml(
          response,
          html(
            'Video Fixture Lab',
            `<h1>Video Fixture Lab</h1>
            <nav>
              <a href="/static">Static Page</a>
              <a href="/animation">Animation</a>
              <a href="/dynamic_loading">Dynamic Loading</a>
              <a href="/checkboxes">Checkboxes</a>
              <a href="/windows">Multiple Windows</a>
              <a href="/alerts">Alerts</a>
            </nav>`,
          ),
        )
        return
      case '/static':
        sendHtml(
          response,
          html(
            'Static Video Fixture',
            '<h1>Static Video Fixture</h1><p id="static-copy">This page is intentionally static.</p>',
          ),
        )
        return
      case '/animation':
        sendHtml(
          response,
          html(
            'Animated Video Fixture',
            `<h1>Animated Video Fixture</h1>
            <div id="animated-box" style="width: 80px; height: 80px; background: #2563eb; position: relative;"></div>
            <p id="animation-status">Animation running</p>`,
            `<script>
              const box = document.querySelector('#animated-box')
              const status = document.querySelector('#animation-status')
              const startedAt = performance.now()
              const animate = (now) => {
                const elapsed = now - startedAt
                box.style.transform = 'translateX(' + Math.min(320, elapsed / 3) + 'px) rotate(' + elapsed / 2 + 'deg)'
                if (elapsed >= 1000) {
                  status.textContent = 'Animation complete'
                  document.body.dataset.animationState = 'complete'
                  return
                }
                requestAnimationFrame(animate)
              }
              requestAnimationFrame(animate)
            </script>`,
          ),
        )
        return
      case '/nested_frames':
        sendHtml(
          response,
          `<!doctype html><html lang="en"><head><title>Nested Frames</title></head>
          <frameset rows="70%,30%">
            <frame name="frame-top" src="/frames/top">
            <frame name="frame-bottom" src="/frames/bottom">
          </frameset></html>`,
        )
        return
      case '/frames/top':
        sendHtml(
          response,
          `<!doctype html><html lang="en"><head><title>Top Frames</title></head>
          <frameset cols="25%,50%,25%">
            <frame name="frame-left" src="/frames/left">
            <frame name="frame-middle" src="/frames/middle">
            <frame name="frame-right" src="/frames/right">
          </frameset></html>`,
        )
        return
      case '/frames/left':
        sendHtml(response, html('Left Frame', '<p>LEFT</p>'))
        return
      case '/frames/middle':
        sendHtml(response, html('Middle Frame', '<p id="content">MIDDLE</p>'))
        return
      case '/frames/right':
        sendHtml(response, html('Right Frame', '<p>RIGHT</p>'))
        return
      case '/frames/bottom':
        sendHtml(response, html('Bottom Frame', '<p>BOTTOM</p>'))
        return
      case '/cross-origin-iframe':
        sendHtml(
          response,
          html(
            'Cross-origin Iframe Fixture',
            `<h1>Cross-origin Iframe Fixture</h1>
            <iframe id="cross-origin-frame" title="Cross-origin fixture" src="${crossOriginUrl}/frame-content" style="width: 600px; height: 240px;"></iframe>`,
          ),
        )
        return
      case '/dynamic_loading':
        sendHtml(
          response,
          html(
            'Dynamic Loading',
            `<h1>Dynamic Loading</h1>
            <a href="/dynamic_loading/1">Example 1: Element on page that is hidden</a>`,
          ),
        )
        return
      case '/dynamic_loading/1':
        sendHtml(
          response,
          html(
            'Dynamic Loading Example',
            `<h1>Dynamic Loading Example</h1>
            <div id="start"><button type="button">Start</button></div>
            <div id="finish" style="display: none;"><h4>Hello World!</h4></div>`,
            `<script>
              document.querySelector('#start button').addEventListener('click', () => {
                setTimeout(() => {
                  document.querySelector('#finish').style.display = 'block'
                }, 750)
              })
            </script>`,
          ),
        )
        return
      case '/checkboxes':
        sendHtml(
          response,
          html(
            'Checkboxes',
            `<h1>Checkboxes</h1>
            <form id="checkboxes">
              <label><input id="checkbox-1" type="checkbox"> Checkbox 1</label>
              <label><input id="checkbox-2" type="checkbox" checked> Checkbox 2</label>
            </form>`,
          ),
        )
        return
      case '/windows':
        sendHtml(
          response,
          html(
            'Opening a new window',
            `<h3>Opening a new window</h3>
            <a href="/windows/new" target="_blank">Click Here</a>
            <a id="open-self-closing" href="/windows/self-close" target="_blank">Open self-closing window</a>`,
          ),
        )
        return
      case '/windows/new':
        sendHtml(response, html('New Window', '<h3>New Window</h3>'))
        return
      case '/windows/self-close':
        sendHtml(
          response,
          html(
            'Self-closing Window',
            `<h3>Self-closing Window</h3>
            <button id="close-window" type="button">Close this window</button>`,
            `<script>
              document.querySelector('#close-window').addEventListener('click', () => window.close())
            </script>`,
          ),
        )
        return
      case '/alerts':
        sendHtml(
          response,
          html(
            'JavaScript Alerts',
            `<h1>JavaScript Alerts</h1>
            <button id="show-alert" type="button">Show alert</button>
            <button id="show-confirm" type="button">Show confirm</button>
            <button id="show-prompt" type="button">Show prompt</button>
            <p id="alert-result">No alert handled</p>`,
            `<script>
              const result = document.querySelector('#alert-result')
              document.querySelector('#show-alert').addEventListener('click', () => {
                alert('Fixture alert')
                result.textContent = 'Alert accepted'
              })
              document.querySelector('#show-confirm').addEventListener('click', () => {
                result.textContent = confirm('Fixture confirm') ? 'Confirm accepted' : 'Confirm dismissed'
              })
              document.querySelector('#show-prompt').addEventListener('click', () => {
                result.textContent = 'Prompt: ' + prompt('Fixture prompt', '')
              })
            </script>`,
          ),
        )
        return
      default:
        sendNotFound(response)
    }
  })
}

export const startFixtureServer = async (): Promise<FixtureServer> => {
  const crossOriginServer = createCrossOriginServer()
  const crossOriginUrl = await listen(crossOriginServer)
  const primaryServer = createPrimaryServer(crossOriginUrl)

  try {
    const baseUrl = await listen(primaryServer)
    return {
      baseUrl,
      crossOriginUrl,
      close: async () => {
        await Promise.all([
          closeServer(primaryServer),
          closeServer(crossOriginServer),
        ])
      },
    }
  } catch (error) {
    await closeServer(crossOriginServer)
    throw error
  }
}
