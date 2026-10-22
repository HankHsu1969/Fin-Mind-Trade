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

const sendJson = (res, status, body, cache = 'no-store') => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache });
  res.end(body);
};

// 證交所基本市況報導網站（即時報價）不允許瀏覽器跨網域讀取，代為取得：/twse-mis/stock/api/<檔名>?<參數>
// /twse-mis/ping 讓網頁判斷有沒有本機代理（線上版沒有）
const TWSE_MIS = 'https://mis.twse.com.tw';
const MIS_PATHS = new Set(['/stock/api/getStockInfo.jsp', '/stock/api/getChartOhlcStatis.jsp']);

async function proxyMis(sub, search, res) {
  if (sub === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }
  if (!MIS_PATHS.has(sub)) {
    res.writeHead(404);
    return res.end();
  }
  try {
    const upstream = await fetch(TWSE_MIS + sub + search, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${TWSE_MIS}/stock/index` },
      signal: AbortSignal.timeout(15 * 1000),
    });
    sendJson(res, upstream.status, (await upstream.text()).trim()); // 回應前面有一堆空行
  } catch (err) {
    sendJson(res, 502, JSON.stringify({ error: err.message }));
  }
}

// 證交所沒有個股的當日分時資料，改用 Yahoo 奇摩股市的 1 分 K：/yahoo-chart/2330.TW（上櫃為 .TWO）
// Yahoo 也不允許跨網域，而且要帶瀏覽器的 User-Agent；同一檔 30 秒內共用一次結果
const yahooCache = new Map();

async function proxyYahoo(symbol, res) {
  if (!/^[0-9A-Z]{4,6}\.(TW|TWO)$/.test(symbol)) {
    res.writeHead(404);
    return res.end();
  }
  const hit = yahooCache.get(symbol);
  if (hit && Date.now() - hit.t < 30 * 1000) return sendJson(res, 200, hit.body);
  try {
    const upstream = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
      signal: AbortSignal.timeout(15 * 1000),
    });
    const body = await upstream.text();
    if (upstream.ok) yahooCache.set(symbol, { t: Date.now(), body });
    sendJson(res, upstream.status, body);
  } catch (err) {
    sendJson(res, 502, JSON.stringify({ error: err.message }));
  }
}

const server = http.createServer((req, res) => {
  let url;
  let urlPath;
  try {
    url = new URL(req.url, 'http://localhost');
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath.startsWith('/twse-mis/')) return proxyMis(urlPath.slice('/twse-mis'.length), url.search, res);
  if (urlPath.startsWith('/yahoo-chart/')) return proxyYahoo(urlPath.slice('/yahoo-chart/'.length), res);
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
