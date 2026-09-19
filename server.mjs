// 株価予測アプリ - APIプロキシ + 静的ファイルサーバー(依存パッケージなし)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3900;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

// ローカル銘柄辞書(JPX全上場企業 + 主要グローバル株)
const SYMBOLS = JSON.parse(
  await readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'symbols.json'), 'utf-8'),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Yahoo Financeのセッションcookie(429対策。yfinanceライブラリと同じ正規の手順)
let yahooCookie = null;
async function getYahooCookie() {
  if (yahooCookie) return yahooCookie;
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) yahooCookie = setCookie.split(';')[0];
  } catch { /* cookieなしで続行 */ }
  return yahooCookie;
}

// レスポンスキャッシュ(15分)— データ提供元への負荷とレート制限を回避
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

async function fetchYahoo(path) {
  const cached = cache.get(path);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return { status: 200, body: cached.body };

  const cookie = await getYahooCookie();
  let lastStatus = 0;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const headers = { 'User-Agent': UA, Accept: 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const r = await fetch(`https://${host}${path}`, { headers });
      const body = await r.text();
      lastStatus = r.status;
      if (r.status === 200 && body.startsWith('{')) {
        cache.set(path, { ts: Date.now(), body });
        return { status: 200, body };
      }
      if (r.status === 429) yahooCookie = null; // 次回cookieを取り直す
    } catch { lastStatus = 502; }
  }
  // 期限切れキャッシュでも、あれば返す(レート制限時のフォールバック)
  if (cached) return { status: 200, body: cached.body };
  return {
    status: lastStatus || 502,
    body: JSON.stringify({
      error:
        lastStatus === 429
          ? 'データ提供元(Yahoo Finance)が一時的にレート制限中です。1〜2分待ってから再試行してください。'
          : 'データの取得に失敗しました(status ' + lastStatus + ')',
    }),
  };
}

// ---- フォールバック: FT (markets.ft.com) ----
// Yahooがレート制限中でも取得できる第2のデータソース。
// レスポンスはYahoo chart API互換の形に変換してフロントには透過的に返す。
const ftXidCache = new Map();

async function ftLookupXid(symbol) {
  if (ftXidCache.has(symbol)) return ftXidCache.get(symbol);
  const isJp = symbol.endsWith('.T');
  const query = isJp ? symbol.slice(0, -2) : symbol;
  const r = await fetch(
    `https://markets.ft.com/data/searchapi/searchsecurities?query=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  );
  if (!r.ok) return null;
  const data = await r.json();
  const secs = (data.data && data.data.security) || [];
  let hit = null;
  if (isJp) hit = secs.find((s) => s.symbol === `${query}:TYO`);
  if (!hit) hit = secs.find((s) => s.isPrimary) || secs[0];
  const xid = hit ? hit.xid : null;
  if (xid) ftXidCache.set(symbol, xid);
  return xid;
}

async function fetchFtChart(symbol, range) {
  const cacheKey = `ft:${symbol}:${range}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return { status: 200, body: cached.body };

  const xid = await ftLookupXid(symbol);
  if (!xid) return null;
  const days = { '1y': 365, '2y': 730, '5y': 1825 }[range] || 730;
  const r = await fetch('https://markets.ft.com/data/chartapi/series', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      days,
      dataNormalized: false,
      dataPeriod: 'Day',
      dataInterval: 1,
      realtime: false,
      yFormat: '0.###',
      timeServiceFormat: 'JSON',
      returnDateType: 'ISO8601',
      elements: [{ Type: 'price', Symbol: String(xid) }],
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const el = data.Elements && data.Elements[0];
  const closeSeries = el && el.ComponentSeries.find((s) => s.Type === 'Close');
  if (!el || !closeSeries || !data.Dates || !data.Dates.length) return null;

  // Yahoo chart API互換形式に変換
  const body = JSON.stringify({
    chart: {
      result: [
        {
          meta: { currency: el.Currency || '', symbol, dataSource: 'FT' },
          timestamp: data.Dates.map((d) => Math.floor(new Date(d).getTime() / 1000)),
          indicators: { quote: [{ close: closeSeries.Values }] },
        },
      ],
      error: null,
    },
  });
  cache.set(cacheKey, { ts: Date.now(), body });
  return { status: 200, body };
}

async function proxyJson(res, path) {
  const { status, body } = await fetchYahoo(path);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function searchLocal(q) {
  if (!q) return [];
  const nq = q.normalize('NFKC').toLowerCase();
  const scored = [];
  for (const e of SYMBOLS) {
    const name = e.n.toLowerCase();
    const sym = e.s.toLowerCase();
    let score = -1;
    if (sym === nq || sym.replace(/\.t$/, '') === nq) score = 0; // 銘柄コード完全一致
    else if (name.startsWith(nq)) score = 1;
    else if (name.includes(nq)) score = 2;
    else if (sym.startsWith(nq)) score = 3;
    if (score >= 0) scored.push({ score, e });
  }
  scored.sort((a, b) => a.score - b.score || a.e.n.length - b.e.n.length);
  return scored.slice(0, 10).map(({ e }) => ({
    symbol: e.s,
    shortname: e.n,
    exchDisp: e.x + (e.i !== '-' ? ' / ' + e.i : ''),
    quoteType: 'EQUITY',
  }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 会社名 → 銘柄コード検索(ローカル辞書優先、ヒットなしならYahoo検索)
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    const local = searchLocal(q);
    if (local.length > 0) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ quotes: local }));
    }
    return proxyJson(
      res,
      `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`,
    );
  }

  // 株価履歴の取得(Yahoo → 失敗時はFTにフォールバック)
  if (url.pathname === '/api/chart') {
    const symbol = url.searchParams.get('symbol') || '';
    const range = url.searchParams.get('range') || '2y';
    const yahoo = await fetchYahoo(
      `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=1d`,
    );
    let result = yahoo;
    if (yahoo.status !== 200) {
      try {
        const ft = await fetchFtChart(symbol, range);
        if (ft) result = ft;
      } catch { /* FTも失敗ならYahooのエラーを返す */ }
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(result.body);
  }

  // 静的ファイル
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const file = await readFile(join(PUBLIC_DIR, path));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`stock-predictor running at http://localhost:${PORT}`);
});
