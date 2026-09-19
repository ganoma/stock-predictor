# 株価予測アプリ - 依存パッケージがないので単一ステージで完結する
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3900

# アプリ本体(サーバー・銘柄辞書・フロント一式)
COPY server.mjs symbols.json ./
COPY public ./public

EXPOSE 3900
USER node

# 外部APIへの疎通をヘルスチェック代わりにせず、サーバーの応答のみ確認する
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3900)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
