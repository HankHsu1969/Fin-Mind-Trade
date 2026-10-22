'use strict';

/* ======================================================================
 * FinMind 看盤
 * 預設顯示大盤（加權指數），輸入股票代號後顯示個股詳細交易資訊。
 * 資料來源：FinMind API v4 (https://api.finmindtrade.com/api/v4/data)
 * ==================================================================== */

const API = 'https://api.finmindtrade.com/api/v4/data';
const COLOR = { up: '#f04848', down: '#20b26c', flat: '#9aa4b2' };
const MA = [[5, '#f5a524'], [20, '#3b82f6'], [60, '#c084fc']];
const INDEXES = {
  TAIEX: { name: '加權指數', market: '上市' },
  TPEx: { name: '櫃買指數', market: '上櫃' },
};
const MARKET_LABEL = { twse: '上市', tpex: '上櫃', emerging: '興櫃' };
const DEFAULT_WATCH = ['2330', '2317', '2454', '2308', '0050', '2881'];
const CACHE_TTL = 5 * 60 * 1000;
const PRICE_HISTORY_DAYS = 365 * 3 + 30;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/* ---------------------------------------------------------------- storage */

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* blocked or full */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* blocked */ }
  },
};

/* ------------------------------------------------------------- formatting */

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shortDate = s => s.slice(5).replace('-', '/');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

function monthsAgo(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return ymd(d);
}

const numberFormats = new Map();
function fmt(v, dp = 0) {
  if (v == null || !Number.isFinite(v)) return '—';
  let f = numberFormats.get(dp);
  if (!f) {
    f = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    numberFormats.set(dp, f);
  }
  return f.format(v);
}
const signed = (v, dp = 0) => (v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + fmt(v, dp));
const pctText = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : signed(v, dp) + '%');
const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const arrow = v => (v > 0 ? '▲' : v < 0 ? '▼' : '');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

// 從實際報價推算要顯示幾位小數（台積電 0 位、ETF 2 位、指數 2 位）
function decimalsOf(values) {
  let d = 0;
  for (const v of values) {
    const s = String(v);
    const k = s.includes('.') ? s.split('.')[1].length : 0;
    if (k > d) d = k;
  }
  return Math.min(d, 2);
}

/* ------------------------------------------------------------ FinMind API */

const cache = new Map();

function apiError(msg) {
  if (/upper limit/i.test(msg)) return '已達 FinMind 每小時請求上限，請稍後再試，或到設定填入 API token。';
  if (/level is free|user level/i.test(msg)) return '這項資料需要 FinMind 付費會員等級。';
  if (/token/i.test(msg)) return `API token 有問題：${msg}`;
  return msg;
}

function fm(dataset, params = {}) {
  const query = new URLSearchParams({ dataset, ...params });
  const key = query.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.p;

  const token = store.get('fm_token', '');
  if (token) query.set('token', token);

  logRequest();
  const p = fetch(`${API}?${query}`)
    .then(async res => {
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`連線失敗（HTTP ${res.status}）`);
      if (json.status !== 200) {
        if (/upper limit/i.test(json.msg || '')) quota.exhausted = true;
        throw new Error(apiError(json.msg || `HTTP ${res.status}`));
      }
      quota.exhausted = false;
      return json.data || [];
    })
    .catch(err => {
      cache.delete(key);
      if (err instanceof TypeError) throw new Error('無法連線到 FinMind API，請檢查網路連線。');
      throw err;
    })
    .finally(scheduleQuota);
  cache.set(key, { t: Date.now(), p });
  return p;
}

/* -------------------------------------------------------------- API quota */

// 有 token 時向 FinMind 查帳號用量；沒有 token 時 FinMind 不提供查詢，
// 改用這個瀏覽器近一小時送出的請求數估算（未設 token 上限 300 次/小時）。
const USER_INFO = 'https://api.web.finmindtrade.com/v2/user_info';
const ANON_LIMIT = 300;
const HOUR = 3600 * 1000;
const quota = { used: null, limit: null, source: 'local', error: '', exhausted: false, timer: 0 };

function requestLog() {
  const now = Date.now();
  return store.get('fm_req_log', []).filter(t => now - t < HOUR);
}

function logRequest() {
  store.set('fm_req_log', [...requestLog(), Date.now()]);
}

function scheduleQuota() {
  clearTimeout(quota.timer);
  quota.timer = setTimeout(refreshQuota, 1500);
}

async function refreshQuota() {
  const token = store.get('fm_token', '');
  if (!token) {
    Object.assign(quota, { source: 'local', used: requestLog().length, limit: ANON_LIMIT, error: '' });
    renderQuota();
    return;
  }
  try {
    const res = await fetch(`${USER_INFO}?${new URLSearchParams({ token })}`);
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`HTTP ${res.status}`);
    if (json.status !== 200) throw new Error(json.msg || `HTTP ${res.status}`);
    Object.assign(quota, { source: 'server', used: json.user_count, limit: json.api_request_limit, error: '' });
  } catch (err) {
    Object.assign(quota, { source: 'error', error: err instanceof TypeError ? '無法連線到 FinMind' : err.message });
  }
  renderQuota();
}

function renderQuota() {
  const el = $('#quota');
  if (quota.source === 'error') {
    el.className = 'quota warn';
    el.innerHTML = '<span>API 次數</span><b>查詢失敗</b>';
    el.title = `無法取得 FinMind 帳號用量：${quota.error}（點這裡檢查 token）`;
    return;
  }
  const { used, limit } = quota;
  if (used == null || !limit) return;
  const left = quota.exhausted ? 0 : Math.max(0, limit - used);
  const ratio = left / limit;
  const level = left === 0 ? 'out' : ratio < 0.1 ? 'low' : ratio < 0.3 ? 'mid' : 'ok';
  const estimate = quota.source === 'local';
  el.className = `quota ${level}`;
  el.innerHTML = `<span>${estimate ? 'API 約剩' : 'API 剩餘'}</span><b>${fmt(left)}</b><span>/ ${fmt(limit)} 次</span>`
    + `<i style="width:${ratio * 100}%"></i>`;
  el.title = estimate
    ? `未設定 token：依這個瀏覽器近一小時送出的 ${fmt(used)} 次請求估算，每小時上限 ${limit} 次。\n點這裡設定 token，就能顯示 FinMind 帳號的實際剩餘次數。`
    : `FinMind 帳號用量：已使用 ${fmt(used)} 次，每小時上限 ${fmt(limit)} 次。`;
}

/* ------------------------------------------------------------- stock list */

let stockList = [];
const stockMap = new Map();

async function loadStockList() {
  const today = ymd(new Date());
  let saved = store.get('fm_stock_list', null);
  if (!saved || saved.date !== today || !saved.items?.length) {
    const rows = await fm('TaiwanStockInfo');
    const byId = new Map();
    for (const r of rows) {
      const cur = byId.get(r.stock_id);
      if (!cur) {
        byId.set(r.stock_id, { id: r.stock_id, name: r.stock_name, ind: [r.industry_category], type: r.type, date: r.date });
        continue;
      }
      if (!cur.ind.includes(r.industry_category)) cur.ind.push(r.industry_category);
      if (r.date > cur.date) Object.assign(cur, { name: r.stock_name, type: r.type, date: r.date });
    }
    const items = [...byId.values()].map(({ id, name, ind, type }) => ({ id, name, ind: ind.slice(0, 2).join('、'), type }));
    saved = { date: today, items };
    store.set('fm_stock_list', saved);
  }
  stockList = saved.items;
  stockMap.clear();
  for (const s of stockList) stockMap.set(s.id, s);
}

function searchStocks(text) {
  const q = text.trim().toUpperCase();
  if (!q) return [];
  const idHits = [];
  const nameStarts = [];
  const nameHits = [];
  for (const s of stockList) {
    if (s.id.toUpperCase().startsWith(q)) idHits.push(s);
    else if (s.name.toUpperCase().startsWith(q)) nameStarts.push(s);
    else if (s.name.toUpperCase().includes(q)) nameHits.push(s);
  }
  idHits.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  return [...idHits, ...nameStarts, ...nameHits].slice(0, 12);
}

const nameOf = id => INDEXES[id]?.name || stockMap.get(id)?.name || id;

/* ------------------------------------------------------------- indicators */

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    e = e == null ? v : v * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// KD(9,3,3)：台灣慣用參數
function kd(bars, n = 9) {
  const K = [];
  const D = [];
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) { K.push(null); D.push(null); continue; }
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    const rsv = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    k = (k * 2) / 3 + rsv / 3;
    d = (d * 2) / 3 + k / 3;
    K.push(k);
    D.push(d);
  }
  return { K, D };
}

// MACD(12,26,9)：DIF、MACD(訊號線)、OSC(柱狀)
function macd(closes) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const dif = closes.map((_, i) => (i >= 25 ? e12[i] - e26[i] : null));
  const sig = ema(dif, 9);
  const osc = dif.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { dif, sig, osc };
}

// RSI（Wilder 平滑）
function rsi(closes, n) {
  const out = new Array(closes.length).fill(null);
  let up = 0;
  let dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const u = Math.max(diff, 0);
    const d = Math.max(-diff, 0);
    if (i <= n) {
      up += u;
      dn += d;
      if (i < n) continue;
      up /= n;
      dn /= n;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + d) / n;
    }
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

/* ------------------------------------------------------------------ chart */

const LC = window.LightweightCharts;
const ch = {
  main: null,
  sub: null,
  candle: null,
  volume: null,
  ma: [],
  maVals: [],
  subSeries: [],
  subAnchor: null,
  subVals: [],
  subLegend: null,
  bars: [],
  kind: 'index',
  prec: 2,
  ind: store.get('fm_ind', 'kd'),
  range: store.get('fm_range', 132),
};

function chartOptions() {
  return {
    autoSize: true,
    layout: {
      background: { type: LC.ColorType.Solid, color: '#121821' },
      textColor: '#8592a3',
      fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily,
      attributionLogo: false, // 改在頁尾標示 TradingView 授權
    },
    grid: { vertLines: { color: '#19212d' }, horzLines: { color: '#19212d' } },
    rightPriceScale: { borderColor: '#222c3a', minimumWidth: 78 },
    timeScale: { borderColor: '#222c3a', rightOffset: 4, minBarSpacing: 1, lockVisibleTimeRangeOnResize: true },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
  };
}

function initCharts() {
  const base = chartOptions();
  ch.main = LC.createChart($('#chart-main'), {
    ...base,
    timeScale: { ...base.timeScale, visible: false },
    localization: { ...base.localization, priceFormatter: v => fmt(v, ch.prec) },
  });
  ch.candle = ch.main.addCandlestickSeries({
    upColor: COLOR.up, downColor: COLOR.down,
    borderUpColor: COLOR.up, borderDownColor: COLOR.down,
    wickUpColor: COLOR.up, wickDownColor: COLOR.down,
  });
  ch.candle.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.24 } });
  ch.volume = ch.main.addHistogramSeries({
    priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
  });
  ch.main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  ch.ma = MA.map(([, color]) => ch.main.addLineSeries({
    color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  }));

  ch.sub = LC.createChart($('#chart-sub'), base);

  // 主圖與指標圖同步捲動、縮放
  let syncing = false;
  const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (syncing || !range) return;
    syncing = true;
    b.timeScale().setVisibleLogicalRange(range);
    syncing = false;
  });
  link(ch.main, ch.sub);
  link(ch.sub, ch.main);

  // 十字線同步：只轉送滑鼠所在那張圖的事件，避免互相觸發
  let hover = null;
  $('#chart-main').addEventListener('mouseenter', () => { hover = 'main'; });
  $('#chart-sub').addEventListener('mouseenter', () => { hover = 'sub'; });
  for (const sel of ['#chart-main', '#chart-sub']) {
    $(sel).addEventListener('mouseleave', () => {
      hover = null;
      ch.main.clearCrosshairPosition();
      ch.sub.clearCrosshairPosition();
      renderLegend();
    });
  }
  const barIndex = p => {
    if (p.time == null || p.logical == null) return undefined;
    const i = Math.round(p.logical);
    return i >= 0 && i < ch.bars.length ? i : undefined;
  };
  ch.main.subscribeCrosshairMove(p => {
    if (hover !== 'main') return;
    const i = barIndex(p);
    renderLegend(i);
    if (i == null || !ch.subAnchor) ch.sub.clearCrosshairPosition();
    else ch.sub.setCrosshairPosition(ch.subVals[i] ?? 0, ch.bars[i].time, ch.subAnchor);
  });
  ch.sub.subscribeCrosshairMove(p => {
    if (hover !== 'sub') return;
    const i = barIndex(p);
    renderLegend(i);
    if (i == null) ch.main.clearCrosshairPosition();
    else ch.main.setCrosshairPosition(ch.bars[i].close, ch.bars[i].time, ch.candle);
  });
}

const withGaps = (times, values) => values.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v }));

function setChartData(rows, kind) {
  ch.kind = kind;
  ch.bars = rows
    .filter(r => r.open > 0 && r.close > 0)
    .map(r => ({
      time: r.date,
      open: r.open,
      high: r.max,
      low: r.min,
      close: r.close,
      change: r.spread,
      shares: r.Trading_Volume,
      money: r.Trading_money,
      turnover: r.Trading_turnover,
      vol: kind === 'index' ? r.Trading_money / 1e8 : r.Trading_Volume / 1000,
    }));
  const bars = ch.bars;
  const times = bars.map(b => b.time);
  const closes = bars.map(b => b.close);

  ch.prec = kind === 'index' ? 2 : decimalsOf(bars.slice(-120).flatMap(b => [b.open, b.high, b.low, b.close]));
  ch.candle.applyOptions({ priceFormat: { type: 'price', precision: ch.prec, minMove: 1 / 10 ** ch.prec } });
  ch.candle.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  ch.volume.setData(bars.map(b => ({
    time: b.time,
    value: b.vol,
    color: b.close >= b.open ? 'rgba(240,72,72,.45)' : 'rgba(32,178,108,.45)',
  })));
  ch.maVals = MA.map(([n]) => sma(closes, n));
  ch.ma.forEach((series, k) => series.setData(withGaps(times, ch.maVals[k])));

  renderIndicator();
  applyRange();
  renderLegend();
  hideChartMsg();
  return bars;
}

function clearChart() {
  ch.bars = [];
  ch.candle.setData([]);
  ch.volume.setData([]);
  ch.ma.forEach(s => s.setData([]));
  renderIndicator();
  renderLegend();
}

function renderIndicator() {
  for (const s of ch.subSeries) ch.sub.removeSeries(s);
  ch.subSeries = [];
  ch.subAnchor = null;
  ch.subVals = [];
  ch.subLegend = null;
  const bars = ch.bars;
  if (!bars.length) return;

  const times = bars.map(b => b.time);
  const closes = bars.map(b => b.close);
  const line = (values, color) => {
    const s = ch.sub.addLineSeries({
      color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(withGaps(times, values));
    ch.subSeries.push(s);
    return s;
  };
  const guide = (series, price) => series.createPriceLine({
    price, color: '#3a4556', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false,
  });

  if (ch.ind === 'macd') {
    const { dif, sig, osc } = macd(closes);
    const hist = ch.sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    hist.setData(osc.map((v, i) => (v == null
      ? { time: times[i] }
      : { time: times[i], value: v, color: v >= 0 ? 'rgba(240,72,72,.7)' : 'rgba(32,178,108,.7)' })));
    ch.subSeries.push(hist);
    ch.subAnchor = line(dif, '#f5a524');
    line(sig, '#3b82f6');
    ch.subVals = dif;
    ch.subLegend = i => [['MACD(12,26,9)', null], ['DIF', dif[i], '#f5a524'], ['MACD', sig[i], '#3b82f6'], ['OSC', osc[i], osc[i] >= 0 ? COLOR.up : COLOR.down]];
  } else if (ch.ind === 'rsi') {
    const r6 = rsi(closes, 6);
    const r12 = rsi(closes, 12);
    ch.subAnchor = line(r6, '#f5a524');
    line(r12, '#3b82f6');
    guide(ch.subAnchor, 70);
    guide(ch.subAnchor, 30);
    ch.subVals = r6;
    ch.subLegend = i => [['RSI', null], ['RSI6', r6[i], '#f5a524'], ['RSI12', r12[i], '#3b82f6']];
  } else {
    const { K, D } = kd(bars);
    ch.subAnchor = line(K, '#f5a524');
    line(D, '#3b82f6');
    guide(ch.subAnchor, 80);
    guide(ch.subAnchor, 20);
    ch.subVals = K;
    ch.subLegend = i => [['KD(9,3,3)', null], ['K', K[i], '#f5a524'], ['D', D[i], '#3b82f6']];
  }
}

function applyRange() {
  const n = ch.bars.length;
  if (!n) return;
  const from = ch.range && ch.range < n ? n - ch.range : 0;
  ch.main.timeScale().setVisibleLogicalRange({ from: from - 0.5, to: n - 1 + 4 });
}

function renderLegend(i) {
  const bars = ch.bars;
  if (!bars.length) {
    $('#legend').innerHTML = '';
    $('#legend-sub').innerHTML = '';
    return;
  }
  if (i == null) i = bars.length - 1;
  const b = bars[i];
  const prev = b.close - b.change;
  const p = v => fmt(v, ch.prec);
  const item = (k, v, c = '') => `<span><span class="k">${k}</span><b class="${c}">${v}</b></span>`;
  const volText = ch.kind === 'index' ? `${fmt(b.vol, 0)} 億` : `${fmt(b.vol, 0)} 張`;
  $('#legend').innerHTML = [
    `<span class="muted">${b.time.replaceAll('-', '/')}</span>`,
    item('開', p(b.open), cls(b.open - prev)),
    item('高', p(b.high), cls(b.high - prev)),
    item('低', p(b.low), cls(b.low - prev)),
    item('收', p(b.close), cls(b.change)),
    item('漲跌', `${arrow(b.change)}${fmt(Math.abs(b.change), ch.prec)} (${pctText(prev ? (b.change / prev) * 100 : 0)})`, cls(b.change)),
    item(ch.kind === 'index' ? '金額' : '量', volText),
    ...MA.map(([n, color], k) => `<span><span class="k" style="color:${color}">MA${n}</span><b>${p(ch.maVals[k]?.[i])}</b></span>`),
  ].join('');

  const sub = ch.subLegend ? ch.subLegend(i) : [];
  $('#legend-sub').innerHTML = sub
    .map(([k, v, color]) => (v === null && !color
      ? `<span class="muted">${k}</span>`
      : `<span><span class="k" style="color:${color}">${k}</span><b>${fmt(v, 2)}</b></span>`))
    .join('');
}

function showChartMsg(html) {
  const el = $('#chart-msg');
  el.innerHTML = html;
  el.hidden = false;
}
const hideChartMsg = () => { $('#chart-msg').hidden = true; };

/* ------------------------------------------------------------- bar charts */

// 營收、毛利、EPS 用的 SVG 柱狀圖：單一 y 軸、細柱（≤24px）、4px 圓角柱頂、
// 柱與堆疊段之間留 2px 間隔；滑鼠移到或鍵盤聚焦某一欄時顯示提示，並可切換成表格。
const VIZ = {
  accent: '#3987e5',
  context: '#4b5668',
  quarters: ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4'], // Q1→Q4：同一色相、由深到淺
  grid: '#1e2734',
  base: '#3a4659',
  height: 210,
};
const vizResize = new ResizeObserver(entries => entries.forEach(e => drawBarChart(e.target)));
let measureCtx = null;

function textWidth(text) {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  }
  return measureCtx.measureText(text).width;
}

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw * 0.999);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) {
    ticks.push(Number((Math.round(v / step) * step).toPrecision(12)));
  }
  return { ticks, step };
}

// 柱子路徑：資料端 4px 圓角、基線端方角；yEnd < yBase 為向上的柱
function barPath(x, yBase, yEnd, w, round) {
  if (Math.abs(yBase - yEnd) < 0.5) return '';
  const r = round ? Math.min(4, w / 2, Math.abs(yBase - yEnd)) : 0;
  const dir = yEnd < yBase ? 1 : -1;
  const sweep = dir === 1 ? 1 : 0;
  return `M${x},${yBase}V${yEnd + dir * r}`
    + (r ? `A${r},${r} 0 0 ${sweep} ${x + r},${yEnd}` : '')
    + `H${x + w - r}`
    + (r ? `A${r},${r} 0 0 ${sweep} ${x + w},${yEnd + dir * r}` : '')
    + `V${yBase}Z`;
}

function mountChart(el, spec) {
  if (!el) return;
  el._spec = spec;
  el._w = 0;
  drawBarChart(el);
  vizResize.observe(el);
}

function drawBarChart(el) {
  const spec = el._spec;
  const width = Math.round(el.clientWidth);
  if (!spec || !width || width === el._w) return;
  el._w = width;
  const { categories, series, stacked = false, caps = [], height = VIZ.height } = spec;
  const n = categories.length;

  // 數值範圍（堆疊時正負分開累加），一定包含 0
  let lo = 0;
  let hi = 0;
  const tops = categories.map((_, i) => {
    let up = 0;
    let down = 0;
    for (const s of series) {
      const v = s.values[i];
      if (v == null) continue;
      if (stacked) { if (v > 0) up += v; else down += v; } else { up = Math.max(up, v); down = Math.min(down, v); }
    }
    hi = Math.max(hi, up);
    lo = Math.min(lo, down);
    return up;
  });
  const { ticks, step } = niceTicks(lo, hi);
  const tickText = ticks.map(t => fmt(t, decimalsOf([step])));
  const m = { top: 22, right: 4, bottom: 24, left: Math.ceil(Math.max(...tickText.map(textWidth))) + 10 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const y = v => m.top + ph - ((v - t0) / (t1 - t0)) * ph;
  const band = pw / n;
  const k = stacked ? 1 : series.length;
  const barW = Math.max(3, Math.min(24, (band * 0.72 - (k - 1) * 2) / k));
  const groupW = barW * k + (k - 1) * 2;
  const cx = i => m.left + band * (i + 0.5);
  el._geom = { m, band, groupW, width, cx };

  const parts = [`<rect class="hl" x="0" y="${m.top - 16}" width="${band}" height="${ph + 16}" visibility="hidden" />`];
  ticks.forEach((t, j) => {
    const ty = Math.round(y(t)) + 0.5;
    parts.push(`<line x1="${m.left}" x2="${width - m.right}" y1="${ty}" y2="${ty}" stroke="${t === 0 ? VIZ.base : VIZ.grid}" />`,
      `<text x="${m.left - 8}" y="${ty + 4}" text-anchor="end">${tickText[j]}</text>`);
  });

  const allCaps = caps.filter(Boolean).length === n;
  categories.forEach((_, i) => {
    const x0 = cx(i) - groupW / 2;
    if (stacked) {
      const lastUp = series.findLastIndex(s => s.values[i] > 0);
      const lastDown = series.findLastIndex(s => s.values[i] < 0);
      let up = 0;
      let down = 0;
      let upCount = 0;
      let downCount = 0;
      series.forEach((s, j) => {
        const v = s.values[i];
        if (!v) return;
        const from = v > 0 ? up : down;
        let yb = y(from);
        const ye = y(from + v);
        const first = v > 0 ? upCount++ === 0 : downCount++ === 0;
        if (!first) yb += v > 0 ? -2 : 2; // 堆疊段之間 2px 間隔
        if (v > 0) up += v; else down += v;
        if (Math.abs(yb - ye) < 1) return;
        parts.push(`<path d="${barPath(x0, yb, ye, barW, j === (v > 0 ? lastUp : lastDown))}" fill="${s.color}" />`);
      });
    } else {
      series.forEach((s, j) => {
        const v = s.values[i];
        if (v == null) return;
        parts.push(`<path d="${barPath(x0 + j * (barW + 2), y(0), y(v), barW, true)}" fill="${s.color}" />`);
      });
    }
    const cap = caps[i];
    const capW = cap ? textWidth(cap) : 0;
    if (cap && capW <= (allCaps ? band - 4 : band * 2)) {
      // 分組柱可指定標籤屬於哪一根（capSeries），標籤水平對齊那根柱
      const capX = !stacked && spec.capSeries != null ? x0 + spec.capSeries * (barW + 2) + barW / 2 : cx(i);
      const x = Math.min(capX, width - m.right - capW / 2);
      parts.push(`<text class="cap" x="${x}" y="${y(Math.max(0, tops[i])) - 6}" text-anchor="middle">${esc(cap)}</text>`);
    }
  });

  // x 軸標籤太擠時跳著顯示，但最新一欄一定顯示
  const every = Math.max(1, Math.ceil((Math.max(...categories.map(textWidth)) + 8) / band));
  categories.forEach((c, i) => {
    if ((n - 1 - i) % every === 0) parts.push(`<text x="${cx(i)}" y="${height - 6}" text-anchor="middle">${esc(c)}</text>`);
  });
  categories.forEach((_, i) => {
    const tip = spec.tooltip(i);
    const aria = [tip.title, ...tip.rows.map(r => `${r.label} ${r.value}`)].join('，');
    parts.push(`<rect class="hit" data-i="${i}" x="${m.left + band * i}" y="${m.top - 16}" width="${band}" height="${ph + 16}"
      fill="transparent" tabindex="0" role="img" aria-label="${esc(aria)}" />`);
  });

  el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg><div class="viz-tip" hidden></div>`;

  if (!el._bound) {
    el._bound = true;
    el.addEventListener('pointermove', e => {
      const hit = e.target.closest?.('.hit');
      if (hit) showTip(el, Number(hit.dataset.i)); else hideTip(el);
    });
    el.addEventListener('pointerleave', () => hideTip(el));
    el.addEventListener('focusin', e => {
      const hit = e.target.closest('.hit');
      if (hit) showTip(el, Number(hit.dataset.i));
    });
    el.addEventListener('focusout', () => hideTip(el));
  }
}

function showTip(el, i) {
  const { m, band, groupW, width, cx } = el._geom;
  const info = el._spec.tooltip(i);
  const tip = el.querySelector('.viz-tip');
  const node = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  };
  tip.replaceChildren(node('div', 't', info.title));
  let sep = false;
  for (const row of info.rows) {
    if (row.foot && !sep) { tip.append(node('div', 'sep')); sep = true; }
    const r = node('div', 'r');
    const key = node('i', 'key');
    if (row.color) key.style.background = row.color;
    r.append(key, node('b', row.cls || '', row.value), node('span', '', row.label));
    tip.append(r);
  }
  tip.hidden = false;
  const right = cx(i) + groupW / 2 + 10;
  const w = tip.offsetWidth;
  tip.style.left = `${right + w <= width ? right : Math.max(0, cx(i) - groupW / 2 - 10 - w)}px`;
  tip.style.top = `${m.top}px`;
  const hl = el.querySelector('.hl');
  hl.setAttribute('x', m.left + band * i);
  hl.setAttribute('visibility', 'visible');
}

function hideTip(el) {
  const tip = el.querySelector('.viz-tip');
  if (tip) tip.hidden = true;
  el.querySelector('.hl')?.setAttribute('visibility', 'hidden');
}

// 圖表區塊：圖例＋圖表／表格切換＋圖表＋表格（表格是圖表的無障礙替代）
function chartBlock({ legend = [], hint = '', spec, tableHtml }) {
  const view = store.get('fm_viz', 'chart');
  const legendHtml = legend.length > 1
    ? legend.map(([name, color]) => `<span class="lg"><i style="background:${color}"></i>${esc(name)}</span>`).join('')
    : '';
  const html = `
    <div class="viz-bar">
      <div class="viz-legend">${legendHtml}${hint ? `<span>${esc(hint)}</span>` : ''}</div>
      <div class="seg mini" data-viz-toggle>
        <button data-view="chart" class="${view === 'chart' ? 'on' : ''}">圖表</button>
        <button data-view="table" class="${view === 'table' ? 'on' : ''}">表格</button>
      </div>
    </div>
    <div class="viz"${view === 'chart' ? '' : ' hidden'}></div>
    <div class="viz-table"${view === 'table' ? '' : ' hidden'}>${tableHtml}</div>`;
  return { html, mount: root => mountChart(root.querySelector('.viz'), spec) };
}

/* ----------------------------------------------------------------- panels */

function panelHtml(key, title, note) {
  return `
    <section class="card" data-panel="${key}">
      <div class="card-head"><h2>${title}</h2><span class="muted small">${note}</span></div>
      <div class="panel-body"><div class="loading">載入中…</div></div>
    </section>`;
}

// content 可以是 HTML 字串，或 chartBlock 產生的 { html, mount }
function fillPanel(key, content) {
  const el = $(`[data-panel="${key}"] .panel-body`);
  if (!el) return;
  el.innerHTML = typeof content === 'string' ? content : content.html;
  content.mount?.(el);
}

const errHtml = err => `<div class="err">${esc(err.message || err)}</div>`;
const emptyHtml = text => `<div class="loading">${text}</div>`;

async function loadPanel(seq, key, load, render) {
  try {
    const data = await load();
    if (seq === viewSeq) fillPanel(key, render(data));
  } catch (err) {
    if (seq === viewSeq) fillPanel(key, errHtml(err));
  }
}

const numTd = (v, dp = 0) => `<td class="${cls(v)}">${signed(v, dp)}</td>`;
const barTd = (v, dp, max) => `
  <td class="bar-cell ${cls(v)}">
    <i style="width:${max ? (Math.abs(v) / max) * 100 : 0}%;background:currentColor"></i><em>${signed(v, dp)}</em>
  </td>`;
const table = (head, rows) => `
  <div class="tbl-wrap"><table>
    <thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
const summary = items => `<div class="summary">${items.map(([k, v, c = '']) => `<div><span>${k}</span> <b class="${c}">${v}</b></div>`).join('')}</div>`;

// 三大法人：依日期彙總外資(含外資自營商)、投信、自營商(自行買賣+避險)
function groupInstitutional(rows, unit) {
  const byDate = new Map();
  for (const r of rows) {
    let g = byDate.get(r.date);
    if (!g) byDate.set(r.date, (g = { date: r.date, foreign: 0, trust: 0, dealer: 0 }));
    const net = (r.buy - r.sell) / unit;
    if (r.name === 'Foreign_Investor' || r.name === 'Foreign_Dealer_Self') g.foreign += net;
    else if (r.name === 'Investment_Trust') g.trust += net;
    else if (r.name === 'Dealer_self' || r.name === 'Dealer_Hedging') g.dealer += net;
  }
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const d of days) d.total = d.foreign + d.trust + d.dealer;
  return days;
}

function streak(days, key) {
  const sign = Math.sign(days[0]?.[key] || 0);
  let n = 0;
  if (sign) for (const d of days) { if (Math.sign(d[key]) === sign) n++; else break; }
  return sign > 0 ? [`連買 ${n} 日`, 'up'] : sign < 0 ? [`連賣 ${n} 日`, 'down'] : ['—', 'flat'];
}

const sumOf = (days, key, n) => days.slice(0, n).reduce((s, d) => s + d[key], 0);

function institutionalHtml(days, dp, streaks) {
  if (!days.length) return emptyHtml('近期沒有三大法人資料');
  const top = days.slice(0, 10);
  const max = Math.max(...top.map(d => Math.abs(d.total)));
  const head = streaks
    ? summary([
      ['外資', ...streak(days, 'foreign')],
      ['投信', ...streak(days, 'trust')],
      ['近5日合計', signed(sumOf(days, 'total', 5), dp), cls(sumOf(days, 'total', 5))],
      ['近20日合計', signed(sumOf(days, 'total', 20), dp), cls(sumOf(days, 'total', 20))],
    ])
    : summary([
      ['近5日外資', signed(sumOf(days, 'foreign', 5), dp), cls(sumOf(days, 'foreign', 5))],
      ['投信', signed(sumOf(days, 'trust', 5), dp), cls(sumOf(days, 'trust', 5))],
      ['自營商', signed(sumOf(days, 'dealer', 5), dp), cls(sumOf(days, 'dealer', 5))],
    ]);
  return head + table(
    ['日期', '外資', '投信', '自營商', '合計'],
    top.map(d => `<tr><td>${shortDate(d.date)}</td>${numTd(d.foreign, dp)}${numTd(d.trust, dp)}${numTd(d.dealer, dp)}${barTd(d.total, dp, max)}</tr>`),
  );
}

function marketMarginHtml(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date });
    byDate.get(r.date)[r.name] = r;
  }
  const days = [...byDate.values()]
    .filter(g => g.MarginPurchase && g.ShortSale && g.MarginPurchaseMoney)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
    .map(g => ({
      date: g.date,
      money: g.MarginPurchaseMoney.TodayBalance / 1e8,
      moneyChg: (g.MarginPurchaseMoney.TodayBalance - g.MarginPurchaseMoney.YesBalance) / 1e8,
      short: g.ShortSale.TodayBalance,
      shortChg: g.ShortSale.TodayBalance - g.ShortSale.YesBalance,
      ratio: (g.ShortSale.TodayBalance / g.MarginPurchase.TodayBalance) * 100,
    }));
  if (!days.length) return emptyHtml('近期沒有融資融券資料');
  const d = days[0];
  return summary([
    ['融資餘額', `${fmt(d.money, 0)} 億`],
    ['增減', `${signed(d.moneyChg, 2)} 億`, cls(d.moneyChg)],
    ['融券', `${fmt(d.short)} 張`],
    ['券資比', `${fmt(d.ratio, 2)}%`],
  ]) + table(
    ['日期', '融資餘額(億)', '增減', '融券餘額(張)', '增減', '券資比'],
    days.map(x => `<tr><td>${shortDate(x.date)}</td><td>${fmt(x.money, 2)}</td>${numTd(x.moneyChg, 2)}<td>${fmt(x.short)}</td>${numTd(x.shortChg)}<td>${fmt(x.ratio, 2)}%</td></tr>`),
  );
}

function stockMarginHtml(rows) {
  const days = [...rows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  if (!days.length) return emptyHtml('近期沒有融資融券資料（可能非信用交易標的）');
  const ratio = r => (r.MarginPurchaseTodayBalance ? (r.ShortSaleTodayBalance / r.MarginPurchaseTodayBalance) * 100 : null);
  const d = days[0];
  const use = d.MarginPurchaseLimit ? (d.MarginPurchaseTodayBalance / d.MarginPurchaseLimit) * 100 : null;
  return summary([
    ['融資餘額', `${fmt(d.MarginPurchaseTodayBalance)} 張`],
    ['融券餘額', `${fmt(d.ShortSaleTodayBalance)} 張`],
    ['券資比', ratio(d) == null ? '—' : `${fmt(ratio(d), 2)}%`],
    ['資使用率', use == null ? '—' : `${fmt(use, 2)}%`],
  ]) + table(
    ['日期', '融資餘額', '增減', '融券餘額', '增減', '券資比'],
    days.map(r => {
      const mChg = r.MarginPurchaseTodayBalance - r.MarginPurchaseYesterdayBalance;
      const sChg = r.ShortSaleTodayBalance - r.ShortSaleYesterdayBalance;
      return `<tr><td>${shortDate(r.date)}</td><td>${fmt(r.MarginPurchaseTodayBalance)}</td>${numTd(mChg)}<td>${fmt(r.ShortSaleTodayBalance)}</td>${numTd(sChg)}<td>${ratio(r) == null ? '—' : fmt(ratio(r), 2) + '%'}</td></tr>`;
    }),
  );
}

// 大公司用「億」，小公司用「百萬」
const moneyUnit = values => (Math.max(...values.map(Math.abs)) >= 1e9 ? [1e8, '億'] : [1e6, '百萬']);
const quarterOf = date => Math.ceil(Number(date.slice(5, 7)) / 3);
const quarterLabel = date => `${date.slice(0, 4)} Q${quarterOf(date)}`;

// 綜合損益表（FinMind 提供的是單季數值），依季底日期整理成 { date, Revenue, GrossProfit, EPS, ... }，新到舊
function byQuarter(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.date)) map.set(r.date, { date: r.date });
    map.get(r.date)[r.type] = r.value;
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function grossProfitHtml(rows) {
  const quarters = byQuarter(rows).filter(q => q.Revenue != null);
  if (!quarters.length) return emptyHtml('沒有財務報表資料（ETF 沒有財報）');
  if (quarters[0].GrossProfit == null) return emptyHtml('金融業的損益表沒有毛利項目');

  const recent = quarters.slice(0, 4);
  const byDate = new Map(quarters.map(q => [q.date, q]));
  const sameQuarterLastYear = date => byDate.get(`${Number(date.slice(0, 4)) - 1}${date.slice(4)}`);
  const [unit, unitName] = moneyUnit(recent.map(q => q.Revenue));
  const margin = (gp, rev) => (rev ? (gp / rev) * 100 : null);
  const revenue = recent.reduce((s, q) => s + q.Revenue, 0);
  const gross = recent.reduce((s, q) => s + q.GrossProfit, 0);
  const detail = q => {
    const prev = sameQuarterLastYear(q.date);
    return {
      m: margin(q.GrossProfit, q.Revenue),
      mPrev: prev ? margin(prev.GrossProfit, prev.Revenue) : null,
      yoy: prev?.GrossProfit ? ((q.GrossProfit - prev.GrossProfit) / Math.abs(prev.GrossProfit)) * 100 : null,
    };
  };

  // 圖表由舊到新；毛利介於 0 和營收之間時，用「毛利＋營業成本＝營收」的堆疊柱
  const qs = [...recent].reverse();
  const stacked = qs.every(q => q.GrossProfit >= 0 && q.GrossProfit <= q.Revenue);
  const series = stacked
    ? [
      { name: '毛利', color: VIZ.accent, values: qs.map(q => q.GrossProfit / unit) },
      { name: '營業成本', color: VIZ.context, values: qs.map(q => (q.Revenue - q.GrossProfit) / unit) },
    ]
    : [
      { name: '營收', color: VIZ.context, values: qs.map(q => q.Revenue / unit) },
      { name: '毛利', color: VIZ.accent, values: qs.map(q => q.GrossProfit / unit) },
    ];
  const money = v => `${fmt(v / unit, 2)} ${unitName}`;
  const block = chartBlock({
    legend: series.map(s => [s.name, s.color]),
    hint: `${stacked ? '柱高為營收，' : ''}柱頂為毛利率 · 單位：${unitName}元`,
    spec: {
      stacked,
      categories: qs.map(q => quarterLabel(q.date)),
      series,
      caps: qs.map(q => `${fmt(detail(q).m, 1)}%`),
      tooltip: i => {
        const q = qs[i];
        const d = detail(q);
        return {
          title: quarterLabel(q.date),
          rows: [
            { color: VIZ.accent, value: money(q.GrossProfit), label: '毛利' },
            stacked
              ? { color: VIZ.context, value: money(q.Revenue - q.GrossProfit), label: '營業成本' }
              : { color: VIZ.context, value: money(q.Revenue), label: '營收' },
            ...(stacked ? [{ foot: true, value: money(q.Revenue), label: '營收' }] : []),
            { foot: true, value: `${fmt(d.m, 2)}%`, label: d.mPrev == null ? '毛利率' : `毛利率（去年同季 ${fmt(d.mPrev, 2)}%）` },
            { foot: true, value: pctText(d.yoy, 1), label: '毛利年增', cls: cls(d.yoy) },
          ],
        };
      },
    },
    tableHtml: table(
      ['季度', `營收(${unitName})`, `毛利(${unitName})`, '毛利率', '毛利年增'],
      recent.map(q => {
        const d = detail(q);
        return `<tr><td>${quarterLabel(q.date)}</td><td>${fmt(q.Revenue / unit, 2)}</td><td>${fmt(q.GrossProfit / unit, 2)}</td>
          <td title="${d.mPrev == null ? '' : `去年同季 ${fmt(d.mPrev, 2)}%`}">${fmt(d.m, 2)}%</td>
          <td class="${cls(d.yoy)}">${pctText(d.yoy, 1)}</td></tr>`;
      }),
    ),
  });

  return {
    html: summary([
      ['近四季營收', `${fmt(revenue / unit, 2)} ${unitName}`],
      ['毛利', `${fmt(gross / unit, 2)} ${unitName}`],
      ['毛利率', `${fmt(margin(gross, revenue), 2)}%`],
    ]) + block.html
      + `<div class="note">財報按季公布，「過去 12 個月」以最近四季計算，最新一季為 ${quarterLabel(recent[0].date)}。</div>`,
    mount: block.mount,
  };
}

function epsHtml(rows) {
  const quarters = byQuarter(rows).filter(q => q.EPS != null);
  if (!quarters.length) return emptyHtml('沒有 EPS 資料（ETF 沒有財報）');

  const years = new Map();
  for (const q of quarters) {
    const y = Number(q.date.slice(0, 4));
    if (!years.has(y)) years.set(y, [null, null, null, null]);
    years.get(y)[quarterOf(q.date) - 1] = q.EPS;
  }
  // 今年（尚未滿四季）＋最近五個完整年度
  const list = [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, qs]) => ({ y, qs, total: qs.reduce((s, v) => s + (v ?? 0), 0), full: qs.every(v => v != null) }));
  const shown = [];
  let fullYears = 0;
  for (const row of list) {
    if (row.full) { if (fullYears === 5) break; fullYears++; }
    else if (shown.length) continue; // 只保留最新一年的未滿四季資料
    shown.push(row);
  }

  const ttm = quarters.slice(0, 4).reduce((s, q) => s + q.EPS, 0);
  const lastFull = shown.find(r => r.full);
  const growth = (now, before) => (before > 0 ? ((now - before) / before) * 100 : null);
  // 全年比去年全年；今年未滿四季時，比去年同樣季數的累計
  const yearGrowth = r => {
    const prev = years.get(r.y - 1);
    if (!prev) return null;
    const have = r.qs.map(v => v != null);
    if (prev.some((v, q) => have[q] && v == null)) return null;
    return growth(r.total, prev.reduce((s, v, q) => s + (have[q] ? v : 0), 0));
  };
  const yoy = lastFull ? yearGrowth(lastFull) : null;
  const partial = shown.find(r => !r.full);
  const reported = partial ? partial.qs.filter(v => v != null).length : 0;

  const yrs = [...shown].reverse();
  const block = chartBlock({
    legend: ['Q1', 'Q2', 'Q3', 'Q4'].map((q, j) => [q, VIZ.quarters[j]]),
    hint: `單位：元${partial ? ` · * ${partial.y} 累計至 Q${reported}` : ''}`,
    spec: {
      stacked: true,
      categories: yrs.map(r => (r.full ? String(r.y) : `${r.y}*`)),
      series: ['Q1', 'Q2', 'Q3', 'Q4'].map((name, j) => ({ name, color: VIZ.quarters[j], values: yrs.map(r => r.qs[j]) })),
      caps: yrs.map(r => fmt(r.total, 2)),
      tooltip: i => {
        const r = yrs[i];
        const g = yearGrowth(r);
        return {
          title: `${r.y} 年`,
          rows: [
            ...r.qs.map((v, j) => ({ color: VIZ.quarters[j], value: v == null ? '未公布' : `${fmt(v, 2)} 元`, label: `Q${j + 1}`, cls: v < 0 ? 'down' : '' })),
            { foot: true, value: `${fmt(r.total, 2)} 元`, label: r.full ? '全年' : `累計（Q1–Q${reported}）` },
            { foot: true, value: pctText(g, 1), label: r.full ? '年增' : '累計年增', cls: cls(g) },
          ],
        };
      },
    },
    tableHtml: table(
      ['年度', 'Q1', 'Q2', 'Q3', 'Q4', '全年'],
      shown.map(r => `<tr><td>${r.y}</td>${r.qs.map(v => `<td class="${v < 0 ? 'down' : ''}">${v == null ? '—' : fmt(v, 2)}</td>`).join('')}
        <td><b>${fmt(r.total, 2)}</b>${r.full ? '' : ' <span class="muted small">累計</span>'}</td></tr>`),
    ),
  });

  return {
    html: summary([
      ['近四季 EPS', `${fmt(ttm, 2)} 元`, ttm < 0 ? 'down' : ''],
      ...(lastFull ? [[`${lastFull.y} 全年`, `${fmt(lastFull.total, 2)} 元`], ['年增', pctText(yoy), cls(yoy)]] : []),
    ]) + block.html + '<div class="note">基本每股盈餘，全年為四季加總，可能與公司公告的年度 EPS 差 0.01 元左右。</div>',
    mount: block.mount,
  };
}

function revenueHtml(rows) {
  const key = (y, m) => y * 100 + m;
  const byKey = new Map(rows.map(r => [key(r.revenue_year, r.revenue_month), r.revenue]));
  const months = rows
    .map(r => ({ y: r.revenue_year, m: r.revenue_month, v: r.revenue }))
    .sort((a, b) => key(b.y, b.m) - key(a.y, a.m));
  if (!months.length) return emptyHtml('沒有月營收資料（ETF 或指數沒有月營收）');

  const [unit, unitName] = moneyUnit(months.map(r => r.v));
  const prevMonth = ({ y, m }) => (m === 1 ? key(y - 1, 12) : key(y, m - 1));
  const growth = (now, before) => (before ? ((now - before) / before) * 100 : null);

  const latest = months[0];
  const ytd = months.filter(r => r.y === latest.y && r.m <= latest.m).reduce((s, r) => s + r.v, 0);
  const ytdPrev = [...byKey.entries()]
    .filter(([k]) => Math.floor(k / 100) === latest.y - 1 && k % 100 <= latest.m)
    .reduce((s, [, v]) => s + v, 0);
  const lastYearCount = [...byKey.keys()].filter(k => Math.floor(k / 100) === latest.y - 1 && k % 100 <= latest.m).length;
  const yoyLatest = growth(latest.v, byKey.get(key(latest.y - 1, latest.m)));
  const ytdGrowth = lastYearCount === latest.m ? growth(ytd, ytdPrev) : null;

  const top = months.slice(0, 12);
  const sumV = list => list.reduce((s, r) => s + r.v, 0);
  const prior12 = months.slice(12, 24);
  const ttmGrowth = prior12.length === 12 ? growth(sumV(top), sumV(prior12)) : null;
  const lastYear = r => byKey.get(key(r.y - 1, r.m)) ?? null;
  const money = v => (v == null ? '—' : `${fmt(v / unit, 2)} ${unitName}`);

  // 圖表由舊到新：每月一組「去年同月（灰）＋當月（藍）」，年增看得出來又不用第二個 y 軸
  const ms = [...top].reverse();
  const block = chartBlock({
    legend: [['營收', VIZ.accent], ['去年同月', VIZ.context]],
    hint: `單位：${unitName}元`,
    spec: {
      categories: ms.map(r => `${String(r.y).slice(2)}/${pad(r.m)}`),
      series: [
        { name: '去年同月', color: VIZ.context, values: ms.map(r => (lastYear(r) == null ? null : lastYear(r) / unit)) },
        { name: '營收', color: VIZ.accent, values: ms.map(r => r.v / unit) },
      ],
      caps: ms.map((r, i) => (i === ms.length - 1 ? fmt(r.v / unit, r.v / unit >= 100 ? 0 : 1) : null)),
      capSeries: 1,
      tooltip: i => {
        const r = ms[i];
        const yoy = growth(r.v, lastYear(r));
        const mom = growth(r.v, byKey.get(prevMonth(r)));
        return {
          title: `${r.y}/${pad(r.m)}`,
          rows: [
            { color: VIZ.accent, value: money(r.v), label: '營收' },
            { color: VIZ.context, value: money(lastYear(r)), label: '去年同月' },
            { foot: true, value: pctText(yoy, 1), label: '年增', cls: cls(yoy) },
            { foot: true, value: pctText(mom, 1), label: '月增', cls: cls(mom) },
          ],
        };
      },
    },
    tableHtml: table(
      ['年月', `營收(${unitName})`, '月增', '年增'],
      top.map(r => {
        const mom = growth(r.v, byKey.get(prevMonth(r)));
        const yoy = growth(r.v, lastYear(r));
        return `<tr><td>${r.y}/${pad(r.m)}</td><td>${fmt(r.v / unit, 2)}</td>
          <td class="${cls(mom)}">${pctText(mom, 1)}</td><td class="${cls(yoy)}">${pctText(yoy, 1)}</td></tr>`;
      }),
    ),
  });

  return {
    html: summary([
      [`${latest.y}/${pad(latest.m)} 營收`, `${fmt(latest.v / unit, 2)} ${unitName}`],
      ['年增', pctText(yoyLatest), cls(yoyLatest)],
      [`${latest.y} 累計年增`, pctText(ytdGrowth), cls(ytdGrowth)],
      [`近 ${top.length} 個月合計`, `${fmt(sumV(top) / unit, 2)} ${unitName}`],
      [`近 ${top.length} 個月年增`, pctText(ttmGrowth), cls(ttmGrowth)],
    ]) + block.html,
    mount: block.mount,
  };
}

function newsHtml(rows) {
  const seen = new Set();
  const items = rows
    .map(r => ({ ...r, at: new Date(r.date.replace(' ', 'T') + 'Z') })) // FinMind 新聞時間為 UTC
    .sort((a, b) => b.at - a.at)
    .filter(r => !seen.has(r.title) && seen.add(r.title))
    .slice(0, 20);
  if (!items.length) return emptyHtml('近兩日沒有相關新聞');
  const when = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `<ul class="news">${items.map(r => `
    <li><a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
    <div class="meta">${esc(r.source)} · ${when(r.at)}</div></li>`).join('')}</ul>`;
}

function dailyHtml(bars, kind) {
  if (!bars.length) return emptyHtml('沒有資料');
  const p = v => fmt(v, ch.prec);
  const rows = bars.slice(-15).reverse();
  return table(
    ['日期', '開盤', '最高', '最低', '收盤', '漲跌', '漲跌%', kind === 'index' ? '金額(億)' : '量(張)'],
    rows.map(b => {
      const prev = b.close - b.change;
      const pct = prev ? (b.change / prev) * 100 : 0;
      return `<tr><td>${shortDate(b.time)}</td><td>${p(b.open)}</td><td>${p(b.high)}</td><td>${p(b.low)}</td>
        <td class="${cls(b.change)}">${p(b.close)}</td><td class="${cls(b.change)}">${signed(b.change, ch.prec)}</td>
        <td class="${cls(b.change)}">${pctText(pct)}</td><td>${fmt(b.vol, 0)}</td></tr>`;
    }),
  );
}

/* ------------------------------------------------------------ quote header */

function quoteHtml({ title, id, tags = [], starred = null, bars, extra = [], note = '' }) {
  const star = starred == null ? ''
    : `<button class="star ${starred ? 'on' : ''}" data-star="${esc(id)}">${starred ? '★ 已加入自選' : '☆ 加入自選'}</button>`;
  const head = `
    <div class="q-title">
      <h1>${esc(title)}</h1><span class="sid">${esc(id)}</span>
      ${tags.filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      ${star}
    </div>`;
  if (!bars?.length) {
    return `<div>${head}<div class="q-date">${note || '載入中…'}</div></div>`;
  }
  const b = bars[bars.length - 1];
  const prev = b.close - b.change;
  const pct = prev ? (b.change / prev) * 100 : 0;
  const year = bars.slice(-250);
  const p = v => fmt(v, ch.prec);
  const stats = [
    ['開盤', p(b.open), cls(b.open - prev)],
    ['最高', p(b.high), cls(b.high - prev)],
    ['最低', p(b.low), cls(b.low - prev)],
    ['昨收', p(prev)],
    ...extra,
    ['振幅', `${fmt(((b.high - b.low) / prev) * 100, 2)}%`],
    ['52週高', p(Math.max(...year.map(x => x.high)))],
    ['52週低', p(Math.min(...year.map(x => x.low)))],
  ];
  return `
    <div>
      ${head}
      <div class="q-price ${cls(b.change)}">
        <span class="price">${p(b.close)}</span>
        <span class="chg">${arrow(b.change)} ${fmt(Math.abs(b.change), ch.prec)}　${pctText(pct)}</span>
      </div>
      <div class="q-date">資料日期 ${b.time.replaceAll('-', '/')}（盤後日資料）</div>
    </div>
    <div class="stats">
      ${stats.map(([k, v, c = '']) => `<div class="stat"><span>${k}</span><b class="${c}">${v}</b></div>`).join('')}
    </div>`;
}

function setTitle(name, bars) {
  const b = bars?.[bars.length - 1];
  if (!b) { document.title = `${name} · FinMind 看盤`; return; }
  const prev = b.close - b.change;
  document.title = `${name} ${fmt(b.close, ch.prec)} ${arrow(b.change)}${pctText(prev ? (b.change / prev) * 100 : 0)} · FinMind 看盤`;
}

/* ------------------------------------------------------------------ views */

let viewSeq = 0;
let current = { type: 'index', id: 'TAIEX' };
let listReady = Promise.resolve();

function markNav() {
  for (const a of $$('.nav a')) a.classList.toggle('on', current.type === 'index' && a.dataset.nav === current.id);
  for (const li of $$('#watchlist li[data-id]')) li.classList.toggle('current', current.type === 'stock' && li.dataset.id === current.id);
}

async function showIndex(id) {
  const seq = ++viewSeq;
  current = { type: 'index', id };
  markNav();
  const meta = INDEXES[id];
  const tags = [`${meta.market}指數`];
  document.title = `${meta.name} · FinMind 看盤`;
  $('#quote').innerHTML = quoteHtml({ title: meta.name, id, tags });
  vizResize.disconnect();
  $('#panels').innerHTML = [
    panelHtml('inst', '三大法人買賣超', '上市整體市場 · 億元'),
    panelHtml('margin', '融資融券', '上市整體市場'),
    panelHtml('daily', '近期行情', meta.name),
  ].join('');
  showChartMsg('載入中…');

  loadPanel(seq, 'inst', () => fm('TaiwanStockTotalInstitutionalInvestors', { start_date: daysAgo(45) }),
    rows => institutionalHtml(groupInstitutional(rows, 1e8), 2, false));
  loadPanel(seq, 'margin', () => fm('TaiwanStockTotalMarginPurchaseShortSale', { start_date: daysAgo(30) }), marketMarginHtml);

  try {
    const rows = await fm('TaiwanStockPrice', { data_id: id, start_date: daysAgo(PRICE_HISTORY_DAYS) });
    if (seq !== viewSeq) return;
    if (!rows.length) throw new Error('查無指數資料');
    const bars = setChartData(rows, 'index');
    $('#quote').innerHTML = quoteHtml({
      title: meta.name, id, tags, bars,
      extra: [
        ['成交金額', `${fmt(bars[bars.length - 1].vol, 0)} 億`],
        ['成交筆數', fmt(bars[bars.length - 1].turnover)],
      ],
    });
    setTitle(meta.name, bars);
    fillPanel('daily', dailyHtml(bars, 'index'));
  } catch (err) {
    if (seq !== viewSeq) return;
    clearChart();
    showChartMsg(esc(err.message));
    $('#quote').innerHTML = quoteHtml({ title: meta.name, id, tags, note: esc(err.message) });
    fillPanel('daily', errHtml(err));
  }
}

async function showStock(id) {
  const seq = ++viewSeq;
  current = { type: 'stock', id };
  markNav();

  const q = { bars: null, per: null, share: null, note: '' };
  const draw = () => {
    if (seq !== viewSeq) return;
    const info = stockMap.get(id);
    const name = info?.name || id;
    const extra = [];
    const last = q.bars?.[q.bars.length - 1];
    if (last) {
      extra.push(['成交量', `${fmt(last.shares / 1000)} 張`], ['成交金額', `${fmt(last.money / 1e8, 2)} 億`]);
    }
    extra.push(
      ['本益比', q.per?.PER ? fmt(q.per.PER, 2) : '—'],
      ['淨值比', q.per?.PBR ? fmt(q.per.PBR, 2) : '—'],
      ['殖利率', q.per ? `${fmt(q.per.dividend_yield, 2)}%` : '—'],
      ['外資持股', q.share ? `${fmt(q.share.ForeignInvestmentSharesRatio, 2)}%` : '—'],
    );
    $('#quote').innerHTML = quoteHtml({
      title: name, id,
      tags: info ? [MARKET_LABEL[info.type], info.ind] : [],
      starred: watch.includes(id),
      bars: q.bars, extra, note: q.note,
    });
    setTitle(name, q.bars);
  };

  draw();
  listReady.then(draw);
  vizResize.disconnect();
  $('#panels').innerHTML = [
    panelHtml('inst', '三大法人買賣超', '張'),
    panelHtml('margin', '融資融券', '張'),
    panelHtml('revenue', '月營收', '近 12 個月'),
    panelHtml('gross', '營收與毛利', '近四季 · 過去 12 個月'),
    panelHtml('eps', 'EPS 每股盈餘', '近五年'),
    panelHtml('daily', '日成交明細', '近 15 個交易日'),
    panelHtml('news', '相關新聞', '近兩日'),
  ].join('');
  showChartMsg('載入中…');

  const recent = daysAgo(14);
  fm('TaiwanStockPER', { data_id: id, start_date: recent })
    .then(rows => { q.per = rows[rows.length - 1] || null; draw(); })
    .catch(() => {});
  fm('TaiwanStockShareholding', { data_id: id, start_date: recent })
    .then(rows => { q.share = rows[rows.length - 1] || null; draw(); })
    .catch(() => {});

  loadPanel(seq, 'inst', () => fm('TaiwanStockInstitutionalInvestorsBuySell', { data_id: id, start_date: daysAgo(45) }),
    rows => institutionalHtml(groupInstitutional(rows, 1000), 0, true));
  loadPanel(seq, 'margin', () => fm('TaiwanStockMarginPurchaseShortSale', { data_id: id, start_date: daysAgo(30) }), stockMarginHtml);
  loadPanel(seq, 'revenue', () => fm('TaiwanStockMonthRevenue', { data_id: id, start_date: monthsAgo(26) }), revenueHtml);
  // 毛利與 EPS 共用同一次財報請求；從五年前 1 月起抓，才有五個完整年度
  const statements = () => fm('TaiwanStockFinancialStatements', { data_id: id, start_date: `${new Date().getFullYear() - 5}-01-01` });
  loadPanel(seq, 'gross', statements, grossProfitHtml);
  loadPanel(seq, 'eps', statements, epsHtml);
  loadPanel(seq, 'news', async () => {
    // FinMind 新聞每次只回傳一天（UTC 日期），抓今天與昨天
    const utcDay = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const days = await Promise.all([0, 1].map(n => fm('TaiwanStockNews', { data_id: id, start_date: utcDay(n) }).catch(() => [])));
    return days.flat();
  }, newsHtml);

  try {
    const rows = await fm('TaiwanStockPrice', { data_id: id, start_date: daysAgo(PRICE_HISTORY_DAYS) });
    if (seq !== viewSeq) return;
    if (!rows.some(r => r.close > 0)) {
      throw new Error(`查無「${id}」的交易資料，請確認股票代號是否正確。`);
    }
    q.bars = setChartData(rows, 'stock');
    draw();
    fillPanel('daily', dailyHtml(q.bars, 'stock'));
  } catch (err) {
    if (seq !== viewSeq) return;
    clearChart();
    showChartMsg(esc(err.message));
    q.note = esc(err.message);
    draw();
    fillPanel('daily', errHtml(err));
  }
}

function route() {
  let hash = location.hash;
  try { hash = decodeURIComponent(hash); } catch { /* malformed escape, use as-is */ }
  let m = hash.match(/^#\/stock\/(.+)$/);
  if (m) {
    const id = m[1].trim().toUpperCase();
    if (INDEXES[id] || id === 'TPEX') return showIndex(id === 'TAIEX' ? 'TAIEX' : 'TPEx');
    return showStock(id);
  }
  m = hash.match(/^#\/index\/(TAIEX|TPEx)$/);
  return showIndex(m ? m[1] : 'TAIEX');
}

function go(id) {
  const code = id.trim().toUpperCase();
  if (!code) return;
  if (code === 'TAIEX') location.hash = '#/';
  else if (code === 'TPEX') location.hash = '#/index/TPEx';
  else location.hash = `#/stock/${encodeURIComponent(code)}`;
}

/* -------------------------------------------------------------- watchlist */

let watch = store.get('fm_watch', DEFAULT_WATCH);

function saveWatch() {
  store.set('fm_watch', watch);
}

function toggleWatch(id) {
  watch = watch.includes(id) ? watch.filter(x => x !== id) : [...watch, id];
  saveWatch();
  renderWatchlist();
}

async function renderWatchlist() {
  const el = $('#watchlist');
  if (!watch.length) {
    el.innerHTML = '<li class="watch-empty">尚無自選股。在個股頁按「☆ 加入自選」即可加入。</li>';
    return;
  }
  el.innerHTML = watch.map(id => `
    <li data-id="${esc(id)}">
      <div class="w-name"><b>${esc(nameOf(id))}</b><span>${esc(id)}</span></div>
      <div class="w-price muted">…</div>
      <div class="badge flat">—</div>
      <button class="w-del" title="移除自選">×</button>
    </li>`).join('');
  markNav();

  await Promise.all(watch.map(async id => {
    const li = $(`#watchlist li[data-id="${CSS.escape(id)}"]`);
    try {
      const rows = (await fm('TaiwanStockPrice', { data_id: id, start_date: daysAgo(20) })).filter(r => r.close > 0);
      const last = rows[rows.length - 1];
      if (!li || !last) return;
      const prev = last.close - last.spread;
      const pct = prev ? (last.spread / prev) * 100 : 0;
      const dp = decimalsOf(rows.slice(-20).map(r => r.close));
      li.querySelector('.w-price').className = `w-price ${cls(last.spread)}`;
      li.querySelector('.w-price').textContent = fmt(last.close, dp);
      li.querySelector('.badge').className = `badge ${cls(last.spread)}`;
      li.querySelector('.badge').textContent = pctText(pct);
    } catch {
      if (li) li.querySelector('.w-price').textContent = '—';
    }
  }));
}

/* ----------------------------------------------------------------- search */

const qInput = $('#q');
const suggestEl = $('#suggest');
let suggestions = [];
let activeIdx = -1;

function renderSuggest() {
  suggestions = searchStocks(qInput.value);
  activeIdx = suggestions.length ? 0 : -1;
  if (!suggestions.length) { suggestEl.hidden = true; return; }
  suggestEl.innerHTML = suggestions.map((s, i) => `
    <li role="option" data-i="${i}" class="${i === activeIdx ? 'active' : ''}">
      <span class="sid">${esc(s.id)}</span><span class="sname">${esc(s.name)}</span>
      <span class="smeta">${esc(s.ind)}${MARKET_LABEL[s.type] ? ' · ' + MARKET_LABEL[s.type] : ''}</span>
    </li>`).join('');
  suggestEl.hidden = false;
}

function setActive(i) {
  if (!suggestions.length) return;
  activeIdx = (i + suggestions.length) % suggestions.length;
  $$('li', suggestEl).forEach((li, k) => li.classList.toggle('active', k === activeIdx));
  suggestEl.children[activeIdx]?.scrollIntoView({ block: 'nearest' });
}

function submitSearch(i = activeIdx) {
  const text = qInput.value.trim();
  const pick = suggestions[i];
  if (!pick && !/^[0-9A-Za-z]{2,8}$/.test(text)) {
    if (text) toast(`找不到「${text}」`);
    return;
  }
  qInput.value = '';
  suggestEl.hidden = true;
  qInput.blur();
  go(pick ? pick.id : text);
}

qInput.addEventListener('input', renderSuggest);
qInput.addEventListener('focus', () => { if (qInput.value) renderSuggest(); });
qInput.addEventListener('blur', () => setTimeout(() => { suggestEl.hidden = true; }, 120));
qInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); submitSearch(); }
  else if (e.key === 'Escape') { qInput.value = ''; suggestEl.hidden = true; qInput.blur(); }
});
suggestEl.addEventListener('mousedown', e => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  submitSearch(Number(li.dataset.i));
});

// 看盤軟體習慣：直接打數字就開始搜尋
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || $('#settings').open) return;
  if (e.key === '/') { e.preventDefault(); qInput.focus(); }
  else if (/^[0-9A-Za-z]$/.test(e.key)) qInput.focus();
});

/* ------------------------------------------------------- toolbar, dialogs */

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
}

function markSeg(sel, attr, value) {
  for (const b of $$(`${sel} button`)) b.classList.toggle('on', b.dataset[attr] === String(value));
}

$('#ranges').addEventListener('click', e => {
  const b = e.target.closest('button[data-range]');
  if (!b) return;
  ch.range = Number(b.dataset.range);
  store.set('fm_range', ch.range);
  markSeg('#ranges', 'range', ch.range);
  applyRange();
});

$('#indicators').addEventListener('click', e => {
  const b = e.target.closest('button[data-ind]');
  if (!b) return;
  ch.ind = b.dataset.ind;
  store.set('fm_ind', ch.ind);
  markSeg('#indicators', 'ind', ch.ind);
  const range = ch.main.timeScale().getVisibleLogicalRange();
  renderIndicator();
  if (range) ch.sub.timeScale().setVisibleLogicalRange(range);
  renderLegend();
});

$('#quote').addEventListener('click', e => {
  const b = e.target.closest('[data-star]');
  if (!b) return;
  const id = b.dataset.star;
  toggleWatch(id);
  const on = watch.includes(id);
  b.classList.toggle('on', on);
  b.textContent = on ? '★ 已加入自選' : '☆ 加入自選';
  toast(on ? `已將 ${nameOf(id)} 加入自選股` : `已將 ${nameOf(id)} 移出自選股`);
});

$('#watchlist').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest('.w-del')) {
    toggleWatch(id);
    const star = $(`#quote [data-star="${CSS.escape(id)}"]`);
    if (star) { star.classList.remove('on'); star.textContent = '☆ 加入自選'; }
    return;
  }
  go(id);
});

// 面板裡的「圖表／表格」切換，選擇會記住給下次用
$('#panels').addEventListener('click', e => {
  const b = e.target.closest('[data-viz-toggle] button');
  if (!b) return;
  const body = b.closest('.panel-body');
  const view = b.dataset.view;
  store.set('fm_viz', view);
  for (const x of b.parentElement.children) x.classList.toggle('on', x === b);
  const viz = body.querySelector('.viz');
  viz.hidden = view !== 'chart';
  body.querySelector('.viz-table').hidden = view !== 'table';
  if (view === 'chart') {
    viz._w = 0;
    drawBarChart(viz);
  }
});

async function refreshAll() {
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  cache.clear();
  try {
    await Promise.all([route(), renderWatchlist()]);
  } finally {
    btn.classList.remove('spin');
  }
}

$('#btn-refresh').addEventListener('click', refreshAll);

const settings = $('#settings');
function openSettings() {
  $('#token').value = store.get('fm_token', '');
  settings.returnValue = '';
  settings.showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#quota').addEventListener('click', openSettings);
settings.addEventListener('close', () => {
  const action = settings.returnValue;
  if (action === 'save') {
    const token = $('#token').value.trim();
    if (token) store.set('fm_token', token); else store.del('fm_token');
    toast(token ? '已儲存 API token' : '已清除 API token');
  } else if (action === 'clear') {
    store.del('fm_token');
    toast('已清除 API token');
  } else {
    return;
  }
  refreshAll();
});

/* ------------------------------------------------------------------- boot */

function boot() {
  if (!LC) {
    document.body.innerHTML = '<p style="padding:40px;text-align:center">圖表元件載入失敗，請確認網路連線後重新整理。</p>';
    return;
  }
  initCharts();
  markSeg('#ranges', 'range', ch.range);
  markSeg('#indicators', 'ind', ch.ind);

  listReady = loadStockList()
    .then(() => renderWatchlist())
    .catch(err => toast(`股票清單載入失敗：${err.message}`));

  window.addEventListener('hashchange', route);
  route();
  renderWatchlist();

  refreshQuota();
  // 本機估算不需連網，常更新讓過期的請求退出統計；查帳號用量則放慢頻率
  setInterval(() => { if (!store.get('fm_token', '')) refreshQuota(); }, 30 * 1000);
  setInterval(() => { if (store.get('fm_token', '')) refreshQuota(); }, 5 * 60 * 1000);
}

boot();
