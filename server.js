// 簡易靜態伺服器（不需安裝任何套件）：node server.js [--open]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 證交所 OpenAPI 不允許瀏覽器跨網域讀取，由這裡代為取得：/twse-openapi/v1/<路徑>
const TWSE_OPENAPI = 'https://openapi.twse.com.tw';
const proxyCache = new Map(); // 10 分鐘快取，避免重複向證交所要同一份大檔

async function proxyTwse(sub, res) {
  if (sub === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }
  if (!/^\/v1\/[A-Za-z0-9_/]+$/.test(sub)) {
    res.writeHead(404);
    return res.end();
  }
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(body);
  };
  const hit = proxyCache.get(sub);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return send(200, hit.body);
  try {
    const upstream = await fetch(TWSE_OPENAPI + sub, { signal: AbortSignal.timeout(60 * 1000) });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (upstream.ok) proxyCache.set(sub, { t: Date.now(), body });
    send(upstream.status, body);
  } catch (err) {
    send(502, JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath.startsWith('/twse-openapi/')) return proxyTwse(urlPath.slice('/twse-openapi'.length), res);
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT + path.sep) || !TYPES[path.extname(file)]) {
    res.writeHead(404);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`FinMind 看盤已啟動：${url}  （按 Ctrl+C 結束）`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});
