'use strict'
// The tiny local web page that starts a meeting through Zoom's Meeting SDK (the same meeting screen as Zoom's web app, so
// the bot's participant controls work on it unchanged), and the throwaway server that hands it to the bot's own Chrome.
//
// The page loads Zoom's SDK from Zoom's own address at ONE pinned version. The signature and the host's start key reach the
// page through Chrome's devtools connection (never through the address), and the server only listens on this computer.

const http = require('http')

// Bump deliberately: a new SDK version can change Zoom's meeting screen, and the bot's selectors are written against it.
const SDK_VERSION = '6.10.0'
const CDN = 'https://source.zoom.us'
const VENDOR = ['react', 'react-dom', 'redux', 'redux-thunk', 'lodash']

function pageHtml(version = SDK_VERSION) {
  const scripts = [...VENDOR.map((n) => `${CDN}/${version}/lib/vendor/${n}.min.js`), `${CDN}/zoom-meeting-${version}.min.js`, '/host.js']
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Meeting host</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<div id="zmmtg-root"></div>
<div id="aria-notify-area"></div>
${scripts.map((s) => `<script src="${s}"></script>`).join('\n')}
</body></html>
`
}

// Runs in the page. Reads window.__BOT (set by the bot before the page loads) and reports through window.__BOT_STATUS:
//   loading -> initialized (SDK ready; used when there is no signature, as a check) | joining -> joined | error
function pageScript() {
  return `(function () {
  var bot = window.__BOT || {};
  function set(state, detail) { window.__BOT_STATUS = { state: state, detail: String(detail || '').slice(0, 240) }; }
  function why(e) { return e ? [e.errorCode, e.errorMessage || e.message || e.reason].filter(Boolean).join(' ') : ''; }
  set('loading');
  // Zoom's screen raises harmless errors while it draws (a resize notice, for one). They are only noted, never fatal: the
  // SDK's own init and join callbacks, and the driver's time limit, decide whether the start worked.
  window.__BOT_NOTES = [];
  window.addEventListener('error', function (e) { if (window.__BOT_NOTES.length < 5) window.__BOT_NOTES.push(String(e.message || '').slice(0, 120)); });
  try {
    if (typeof ZoomMtg === 'undefined') { set('error', 'The Zoom SDK did not load.'); return; }
    ZoomMtg.setZoomJSLib('${CDN}/' + bot.version + '/lib', '/av');
    ZoomMtg.preLoadWasm();
    ZoomMtg.prepareWebSDK();
    ZoomMtg.i18n.load('en-US');
    ZoomMtg.i18n.onLoad(function () {
      ZoomMtg.init({
        leaveUrl: location.origin + '/left',
        patchJsMedia: true,
        disableCORP: !window.crossOriginIsolated,
        disablePreview: true,
        success: function () {
          if (!bot.signature) { set('initialized'); return; }
          var join = {
            signature: bot.signature,
            sdkKey: bot.sdkKey,
            meetingNumber: bot.meetingNumber,
            userName: bot.userName,
            success: function () { set('joined'); },
            error: function (e) { set('error', 'join: ' + why(e)); }
          };
          if (bot.zak) join.zak = bot.zak;
          set('joining');
          ZoomMtg.join(join);
        },
        error: function (e) { set('error', 'init: ' + why(e)); }
      });
    });
  } catch (e) { set('error', (e && e.message) || 'unknown'); }
})();
`
}

// Serves the page and its script, nothing else, on a random port of this computer only.
function startPageServer(version = SDK_VERSION) {
  const html = pageHtml(version)
  const js = pageScript()
  const headers = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  const server = http.createServer((req, res) => {
    const path = String(req.url || '').split('?')[0]
    if (req.method !== 'GET') { res.writeHead(405, headers('text/plain')); res.end('no'); return }
    if (path === '/') { res.writeHead(200, headers('text/html; charset=utf-8')); res.end(html); return }
    if (path === '/host.js') { res.writeHead(200, headers('text/javascript; charset=utf-8')); res.end(js); return }
    if (path === '/left') { res.writeHead(200, headers('text/html; charset=utf-8')); res.end('<!doctype html><title>left</title><p>Left the meeting.</p>'); return }
    res.writeHead(404, headers('text/plain')); res.end('not found')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}/`, port, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

module.exports = { SDK_VERSION, pageHtml, pageScript, startPageServer }
