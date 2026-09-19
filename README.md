# 株価予測アプリ (stock-predictor)

会社名または銘柄コードで検索し、過去の株価チャートと将来予測(モンテカルロシミュレーション)を表示するWebアプリ。依存パッケージなしのNode.js単体で動作します。

## 起動

### Docker(推奨)

```bash
docker compose up -d
```

docker compose が無い環境では build + run で同じことができます。

```bash
docker build -t stock-predictor . && docker run -d --name stock-predictor -p 3900:3900 stock-predictor
```

いずれも http://localhost:3900 で開きます。ポートを変える場合は `-p 8080:3900`(compose なら `ports` を編集)。
永続化するデータは無いのでボリュームは不要です。

### Node.js を直接使う場合

```bash
node server.mjs
# → http://localhost:3900
```

## 機能

- **銘柄検索**: 日本の全上場企業(JPXリスト約3,700社)+ 主要グローバル株のローカル辞書で検索。ヒットしない場合はYahoo Finance検索APIにフォールバック。
- **株価履歴**: Yahoo Finance chart API(サーバー側プロキシ・15分キャッシュ・レート制限時は期限切れキャッシュで応答)。期間は1年/2年/5年。
- **予測**: 直近約250営業日の対数リターンからドリフトとボラティリティを推定し、幾何ブラウン運動(GBM)で3,000パスのモンテカルロシミュレーション。30/60/90営業日先の中央値と50%/90%信頼区間をファンチャートで表示。
- **指標**: 現在値、予測中央値、年率ボラティリティ、年率トレンド、上昇確率、SMA25/75。

## ファイル構成

- `server.mjs` — 静的配信 + 株価APIプロキシ(cookie取得・15分キャッシュ・Yahoo障害時はFTにフォールバック)
- `public/index.html` — UI一式(検索、Canvasチャート、予測ロジックはクライアント側)
- `symbols.json` — 銘柄辞書。JPX公式の上場企業一覧(data_j.xls)から生成
- `Dockerfile` / `docker-compose.yml` — コンテナ定義。node:24-alpine・非rootユーザー(node)で実行、約230MB

## symbols.json の更新

JPXの[東証上場銘柄一覧](https://www.jpx.co.jp/markets/statistics-equities/misc/01.html)から `data_j.xls` をダウンロードし、内国株式のみ抽出して `{s: "コード.T", n: "銘柄名", x: "市場", i: "業種"}` の配列に変換する。

## 注意

予測は過去の値動きの統計に基づく参考値であり、投資助言ではありません。
