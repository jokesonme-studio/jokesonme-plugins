# 看我笑話 Claude 外掛

讓 Claude 在任何資料夾替你操作看我笑話平台「開發」頁的票：開票、列出與查看票、認領、取消認領、交付、驗收、退回、標不做。規則跟網頁一樣，票記在你本人名下。開票前 Claude 會先把草稿列給你確認。

## 安裝（每台電腦一次）

在 Claude（Claude Code 或桌面 App 的 Code 分頁）輸入這兩行，各按一次 Enter：

```
/plugin marketplace add jokesonme-studio/jokesonme-plugins
/plugin install jokesonme@jokesonme
```

裝好後重新開啟 Claude。

## 連結你的帳號

1. 登入看我笑話平台，到「我的」→「連結 Claude」，按「產生連結碼」。
2. 把頁面上那句「連結看我笑話，代碼 jk_link_…」貼給 Claude。

連結碼 10 分鐘內有效、只能用一次。連好後金鑰存在這台電腦的 `~/.config/jokesonme/claude.json`（Windows：`%APPDATA%\Jokesonme\claude.json`），只有你自己讀得到。

不想用了，或電腦遺失：到平台「我的」→「連結 Claude」按「撤銷」，那台電腦的連結立刻失效。

## 用法

- 「幫我開一張票：行事曆週末的日期太淡」
- 「現在有哪些票？」「我認領了哪些？」
- 「T-3 現在怎樣？」
- 「T-3 我來做」「T-3 做好了，交付」「T-3 驗收通過」

金鑰只能操作「開發」頁，碰不到財務等其他資料。

## 開發

外掛裡的 `plugins/jokesonme/mcp/jokesonme.mjs` 不 import 任何套件（外掛資料夾沒有 node_modules），只用 node 內建模組。

```
npm test
```

本機對開發用平台測試：設環境變數 `JOKESONME_URL=http://localhost:3000`。平台端的 API 與規格在 `jokesonme-studio/jokesonme` 的 `openspec/specs/claude-ticket-tools/`。
