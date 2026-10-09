# NKYS Tube Pro（軽量版）

## 構成
- site/   … GitHub Pages にそのまま置くファイル
- worker/ … api.worker.js（Cloudflare Workers 用 API）

## 1. API (api.worker.js) を動かす
GitHub Pages はサーバー処理を実行できないため、API は Cloudflare Workers に置きます（無料）。
- 方法A: Cloudflare ダッシュボード → Workers → 作成 → api.worker.js を貼り付けてデプロイ
- 方法B: `cd worker && npx wrangler deploy`
発行された URL（例 https://nkys-api.xxx.workers.dev）を控えます。

## 2. サイトに API を設定
site/config.js の `window.NK_API` を上の URL に変更。
（ブラウザで `?api=URL` を付けて開いても一時切替可。`?api=reset` で戻す）

## 3. GitHub Pages に公開
site/ の中身をリポジトリ直下に置き、Settings → Pages → Branch: main / root。
独自ドメインを使わない場合は CNAME を削除してください。
