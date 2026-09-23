// 予算スクリーニング用の株価スナップショットを作る処理
//
// FT(markets.ft.com)は1回のリクエストで50銘柄までまとめて返せるので、
// 全銘柄(約3,700)の終値を数分で取得できる。銘柄コード→FT内部ID(xid)の
// 対応は一度引けば変わらないため ft-xids.json に保存して再利用する。
//
// CLI から使う場合は build-prices.mjs、サーバーの自動更新からは
// server.mjs がこのモジュールを呼ぶ。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const BATCH_SIZE = 50; // 1リクエストあたりの銘柄数
const LOOKUP_CONCURRENCY = 4; // xid検索の並列数(相手のサーバーに配慮して控えめに)

// 東証の内国株式は2018年10月に売買単位が100株へ統一されている
export const UNIT_SHARES = 100;

export async function readJson(dir, name, fallback) {
  try {
    return JSON.parse(await readFile(join(dir, name), 'utf-8'));
  } catch {
    return fallback;
  }
}

// 銘柄コードからFTのxidを引く
async function lookupXid(code) {
  const r = await fetch(
    `https://markets.ft.com/data/searchapi/searchsecurities?query=${encodeURIComponent(code)}`,
    { headers: { 'User-Agent': UA } },
  );
  if (!r.ok) throw new Error(`search ${code}: HTTP ${r.status}`);
  const data = await r.json();
  const secs = (data.data && data.data.security) || [];
  const hit = secs.find((s) => s.symbol === `${code}:TYO`);
  return hit ? String(hit.xid) : null;
}

// xidをまとめて渡して終値を取得する。戻り値は xid → 終値
async function fetchCloses(xids) {
  const r = await fetch('https://markets.ft.com/data/chartapi/series', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      days: 14, // 連休を挟んでも直近の営業日が含まれるよう少し長めに取る
      dataNormalized: false,
      dataPeriod: 'Day',
      dataInterval: 1,
      realtime: false,
      yFormat: '0.###',
      timeServiceFormat: 'JSON',
      returnDateType: 'ISO8601',
      elements: xids.map((x) => ({ Type: 'price', Symbol: String(x) })),
    }),
  });
  if (!r.ok) throw new Error(`series: HTTP ${r.status}`);
  const data = await r.json();
  const out = new Map();
  for (const el of data.Elements || []) {
    if (!el || !el.Symbol || !el.ComponentSeries) continue;
    const close = el.ComponentSeries.find((s) => s.Type === 'Close');
    if (!close || !close.Values) continue;
    // 末尾から遡って最初の有効値を採用する(休場日はnullが入る)
    for (let i = close.Values.length - 1; i >= 0; i--) {
      const v = close.Values[i];
      if (v != null && isFinite(v) && v > 0) {
        out.set(String(el.Symbol), v);
        break;
      }
    }
  }
  const lastDate = (data.Dates || []).slice(-1)[0] || null;
  return { closes: out, lastDate };
}

// FTは1銘柄でも受け付けないIDが混ざるとバッチ全体を400で返す。
// 失敗したら半分に割って再試行し、問題のある銘柄だけを切り捨てる。
async function fetchClosesSplit(xids, log) {
  try {
    return await fetchCloses(xids);
  } catch (e) {
    if (xids.length === 1) {
      log(`  取得できない銘柄を除外: xid=${xids[0]} (${e.message})`);
      return { closes: new Map(), lastDate: null };
    }
    const mid = Math.ceil(xids.length / 2);
    const [a, b] = [await fetchClosesSplit(xids.slice(0, mid), log), await fetchClosesSplit(xids.slice(mid), log)];
    return {
      closes: new Map([...a.closes, ...b.closes]),
      lastDate: b.lastDate || a.lastDate,
    };
  }
}

// 指定した並列数でタスクを流す
async function runPool(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const i = index++;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}

// スナップショットを作って prices.json に書き出す。
// full=false なら株価が未取得の銘柄だけを対象にする(初回構築の再開用)。
// 書き込みに失敗しても、組み立てたスナップショットは返す(読み取り専用環境向け)。
export async function buildSnapshot({ dir, full = false, log = () => {} } = {}) {
  const symbols = await readJson(dir, 'symbols.json', []);
  const jp = symbols.filter((s) => s.s.endsWith('.T')); // 単元株の概念があるのは日本株だけ
  log(`対象: 日本株 ${jp.length} 銘柄${full ? '(全件取り直し)' : ''}`);

  // --- 1. xidの解決(未取得分のみ) ---
  const xids = await readJson(dir, 'ft-xids.json', {});
  const missing = jp.filter((s) => !(s.s in xids));
  if (missing.length) {
    log(`xid未取得 ${missing.length} 件を検索します...`);
    let done = 0;
    let failed = 0;
    await runPool(missing, LOOKUP_CONCURRENCY, async (entry) => {
      const code = entry.s.slice(0, -2);
      try {
        xids[entry.s] = await lookupXid(code);
      } catch {
        xids[entry.s] = null; // 見つからない銘柄もnullで記録し、次回以降引き直さない
        failed++;
      }
      if (++done % 200 === 0) log(`  ${done}/${missing.length} 件完了`);
    });
    await writeFile(join(dir, 'ft-xids.json'), JSON.stringify(xids, null, 0)).catch((e) =>
      log(`ft-xids.json を保存できませんでした: ${e.code || e.message}`),
    );
    log(`xid解決: 完了(取得失敗 ${failed} 件)`);
  }

  // --- 2. 終値の取得 ---
  const prev = await readJson(dir, 'prices.json', { prices: {} });
  const targets = jp.filter((s) => xids[s.s] && (full || prev.prices[s.s] == null));
  log(`株価を取得: ${targets.length} 銘柄 (${BATCH_SIZE}件ずつ)`);

  const prices = full ? {} : { ...prev.prices };
  let lastDate = null;
  let fetched = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const { closes, lastDate: d } = await fetchClosesSplit(chunk.map((s) => xids[s.s]), log);
    for (const s of chunk) {
      const v = closes.get(String(xids[s.s]));
      if (v != null) {
        prices[s.s] = v;
        fetched++;
      }
    }
    if (d) lastDate = d;
    if ((i / BATCH_SIZE) % 10 === 9) {
      log(`  ${Math.min(i + BATCH_SIZE, targets.length)}/${targets.length} 銘柄完了`);
    }
  }

  // 1件も取れなかった(=ネットワーク断やFT側の障害)場合は既存のスナップショットを壊さない
  if (targets.length && fetched === 0) {
    throw new Error('株価を1件も取得できませんでした。既存のスナップショットを維持します。');
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    priceDate: lastDate ? lastDate.slice(0, 10) : prev.priceDate || null,
    source: 'FT (markets.ft.com)',
    unitShares: UNIT_SHARES,
    count: Object.keys(prices).length,
    prices,
  };
  await writeFile(join(dir, 'prices.json'), JSON.stringify(snapshot, null, 0)).catch((e) =>
    log(`prices.json を保存できませんでした(メモリ上の値は更新済み): ${e.code || e.message}`),
  );
  log(`完了: ${snapshot.count} 銘柄(株価日付 ${snapshot.priceDate})`);
  return snapshot;
}
