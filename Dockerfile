# 株価予測アプリ - 依存パッケージがないので単一ステージで完結する
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3900

# アプリ本体(サーバー・株価取得・銘柄辞書・フロント一式)
COPY server.mjs prices-source.mjs build-prices.mjs symbols.json ./
COPY public ./public
# 株価スナップショットと銘柄コード→FT内部IDの対応表。
# 無い場合はサーバーが起動後に自動生成する(初回は数十分かかる)。
COPY prices.jso[n] ft-xids.jso[n] ./

# 株価の自動更新がスナップショットを書き戻せるよう、アプリ配下をnodeユーザー所有にする
RUN chown -R node:node /app

EXPOSE 3900
USER node

# 外部APIへの疎通をヘルスチェック代わりにせず、サーバーの応答のみ確認する
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3900)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
