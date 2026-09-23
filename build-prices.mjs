// 予算スクリーニング用の株価スナップショット(prices.json)を手動で作り直すコマンド
//
//   node build-prices.mjs            株価が未取得の銘柄だけ取得(初回構築の再開用)
//   node build-prices.mjs --full     全銘柄の株価を取り直す(日次更新はこちら)
//
// サーバーは起動時と一定間隔で同じ処理を自動実行するので、通常このコマンドを
// 手で叩く必要はない。取得ロジックは prices-source.mjs にある。
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './prices-source.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));

buildSnapshot({
  dir,
  full: process.argv.includes('--full'),
  log: (msg) => console.log(msg),
}).catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
