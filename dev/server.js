// Local preview server: runs apps-script/Code.gs against an in-memory/JSON "spreadsheet"
// and serves apps-script/Index.html with a stand-in for google.script.run.
//
//   npm run dev            → http://localhost:8080 (data saved in dev/.data.json)
//   LATENCY=800 npm run dev  → simulate slow gym Wi-Fi
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const PORT = Number(process.env.PORT || 8080);
const LATENCY = Number(process.env.LATENCY || 0);
const DATA = process.env.DATA_FILE || path.join(__dirname, '.data.json');
const gas = createGas({ file: DATA, appUrl: 'http://localhost:' + PORT });
gas.context.setup();

const SHIM = `<script>
window.google = { script: { get run() {
  let ok = () => {}, fail = () => {};
  const r = {
    withSuccessHandler(f) { ok = f; return r; },
    withFailureHandler(f) { fail = f; return r; },
    api(req) {
      if (window.__offline) return setTimeout(() => fail(new Error('NetworkError: Connection failure due to HTTP 0')), 50);
      fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
        .then(x => x.json()).then(j => j.ok ? ok(j.result) : fail(new Error(j.error)))
        .catch(e => fail(new Error('NetworkError: ' + e.message)));
    },
  };
  return r;
} } };
</script>`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => setTimeout(() => {
      let out;
      try { out = { ok: true, result: gas.api(JSON.parse(body)) }; } catch (e) { out = { ok: false, error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, LATENCY));
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Index.html'), 'utf8').replace('</head>', SHIM + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => {
  const pin = gas.sheets.Settings.data.find(r => r[0] === 'Coach PIN')[1];
  console.log(`Preview running at http://localhost:${PORT}  (coach PIN: ${pin})`);
});
