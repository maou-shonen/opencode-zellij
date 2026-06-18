# opencode-zellij

[![npm version](https://img.shields.io/npm/v/opencode-zellij.svg)](https://www.npmjs.com/package/opencode-zellij)
[![CI](https://github.com/maou-shonen/opencode-zellij/actions/workflows/ci.yml/badge.svg)](https://github.com/maou-shonen/opencode-zellij/actions/workflows/ci.yml)

[English](README.md)

把需要持續運作的 command(dev servers、watchers、REPLs)跑在可見的 Zellij pane。

## 安裝

把 npm package name 加到 OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-zellij"]
}
```

OpenCode 會在啟動時自動安裝 npm plugins。Zellij 也必須已安裝,且可在 `PATH` 中使用。

## 功能

### `zellij_pty_spawn` 工具
開一個 Zellij pane 來跑可互動、持久的 command。

**Quick reference:**

Call:

```json
{
  "command": "npm",
  "args": ["run", "dev"],
  "probe": { "type": "http", "url": "http://127.0.0.1:3000", "expectStatus": 200 }
}
```

Returns:

```json
{
  "session": { "id": "...", "paneId": "terminal_3" },
  "probe": { "ok": true, "type": "http", "message": "Got 200 from http://127.0.0.1:3000" },
  "output": { "text": "> next dev server running on :3000\n..." }
}
```

**Spec:**

- 開一個 Zellij pane 跑持久或短命 command,並取得 `session.id` 供後續操作。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- 沒指定 ready 訊號時,給短命 command 一點時間輸出再回傳。 [`src/pty/probe.test.ts`](src/pty/probe.test.ts)
- 需要真正等到 ready 訊號時,用 output 匹配或 HTTP probe 等它。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- 壞的 `grep` regex 在 pane 建立前就擋下來,不要浪費 pane slot。 [`src/tools/spawn.test.ts`](src/tools/spawn.test.ts)
- 想 spawn 之前先看看之前還有哪些 pane 還沒清。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- pane 結束時,喚醒擁有該 pane 的 OpenCode session 一次(多個 terminal signal 也只算一次);找不到 `promptAsync` 時 fallback 到 `client.session.prompt`;沒 pane 退出時不會亂叫。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_read` 工具
讀取 pane 最近的 output。

**Quick reference:**

Call:

```json
{ "id": "<session.id>", "grep": "error" }
```

Returns:

```json
{
  "session": { "id": "...", "status": "running", "exitCode": null },
  "output": { "text": "...matched lines...", "matched": 3 },
  "cleanup": { "requested": false, "performed": false, "alreadyClosed": false }
}
```

**Spec:**

- 拉最新 output、用 `grep` 過濾、順便看 pane 目前的狀態。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- `grep` 不是合法 regex 時,會回 warning 而不是整個 read 掛掉。 [`src/tools/read.test.ts`](src/tools/read.test.ts)
- 想讀已退出的 pane 也可以;`pane_closed` 是被外部砍掉,`exit_marker` 是 process 自己結束 —— 用這個分辨。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- 想關掉「讀完就清」的預設行為,可以在 config 設 `pty.cleanupExitedPaneOnRead`,也可以在單次 call 用 tool arg 覆蓋。 [`src/tools/read.test.ts`](src/tools/read.test.ts)
- 第一次 read 把已退出的 pane 關掉後,第二次 read 會回同一個 `tombstone.paneClosedAt` —— 用來判斷是不是同一個 lifecycle。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_write` 工具
對 pane 送 input。

**Quick reference:**

Call:

```json
{ "id": "<session.id>", "data": "yes\n" }
```

Returns:

```json
{ "output": { "text": "...recent output after write..." } }
```

**Spec:**

- 對互動式 pane 送出回應或按鍵,並看到它怎麼反應。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- 不要意外打到 sudo pane —— 它會拒絕寫入。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_list` 工具
列出 plugin 正在追蹤的 pane。

**Quick reference:**

Call(目前 OpenCode session 的所有 pane):

```json
{}
```

Call(單一 pane):

```json
{ "id": "<session.id>" }
```

Returns:

```json
{
  "sessions": [
    { "id": "...", "paneId": "terminal_3", "status": "running", "command": "npm", "args": ["run", "dev"] }
  ],
  "completedPaneIds": ["..."],
  "completedPanes": [
    { "id": "...", "status": "exited", "reason": "exit_marker", "exitCode": 0 }
  ]
}
```

**Spec:**

- 想 spawn 之前先看手邊有哪些 pane(活的或已退出的),或查某一個 pane 的狀態。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### `zellij_pty_kill` 工具
關閉 pane 並從 plugin 移除。

**Quick reference:**

Call:

```json
{ "id": "<session.id>" }
```

Returns(成功):

```json
{
  "killed": true,
  "cleanedUp": true,
  "id": "...",
  "paneId": "terminal_3",
  "output": { "text": "...", "lineCount": 3 },
  "warnings": []
}
```

Returns(`close-pane` 失敗、pane 還在):

```json
{
  "killed": false,
  "cleanedUp": false,
  "session": { "id": "...", "status": "unknown" },
  "output": { "text": "..." },
  "warnings": ["close-pane failed: ..."]
}
```

**Spec:**

- pane 已經不在的話 kill 會 throw —— finally block 一定要 try/catch(e2e 的 `killQuietly` helper 就是這樣做)。 [`src/tools/kill.test.ts`](src/tools/kill.test.ts)
- 正常關 pane:Ctrl-C、等一下、`close-pane`。Ctrl-C 失敗只會變 warning,不會 throw。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- `close-pane` 失敗而且 pane 還在時,session 會保留下來 —— 等一下重試,或先看 warning。 [`src/tools/kill.test.ts`](src/tools/kill.test.ts)
- OpenCode 還沒正常 cleanup 就被 `Ctrl-D` 砍掉時,detached Node.js watchdog process 會接手把 plugin 建立的 pane 清掉。 [`src/zellij/pane-watchdog.test.ts`](src/zellij/pane-watchdog.test.ts) · [`tests/e2e/ci-pane.test.ts`](tests/e2e/ci-pane.test.ts)

### `zellij_pty_request_sudo` 工具
開啟 floating、human-input-only 的 review pane,顯示將要執行的 command,並等待使用者輸入 `YES`。

**Quick reference:**

Call:

```json
{
  "summary": "Need root to install apt packages",
  "scripts": [
    { "command": "apt install -y libsqlite3-dev", "description": "Install build dependency for the local server." }
  ]
}
```

Returns:

```json
{
  "session": { "id": "...", "paneId": "terminal_5", "humanInputOnly": true }
}
```

**Spec:**

- 把 privileged command 交給使用者審核 —— 他們看到 script,自己打 `YES`。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)
- 使用者打的 credentials 只留在 Zellij scrollback,不會進到 agent 或 LLM。 [`tests/e2e/zellij-pane.run.test.ts`](tests/e2e/zellij-pane.run.test.ts)

### Dynamic tab title
更新 Zellij tab title,顯示 project、branch 與 OpenCode 狀態。Title 從 plugin-bound worktree 的 git 讀取(不是從 event payload),所以 out-of-scope session 或 sibling worktree 的事件不會污染它。

**Spec:**

- [`tests/e2e/zellij-tab-title.run.test.ts`](tests/e2e/zellij-tab-title.run.test.ts)
- [`src/zellij/tab-title.test.ts`](src/zellij/tab-title.test.ts)

## 設定

Sidecar config 從 `~/.config/opencode/opencode-zellij.config.jsonc`(user)與 `.opencode/opencode-zellij.config.jsonc`(project)載入。Project config 覆蓋 user config。

**`pty.enabled`** `boolean`,預設 `true`。設為 `false` 時移除所有 `zellij_pty_*` tools。
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`pty.sudoPane`** `"allow" | "deny" | "hide"`,預設 `"allow"`。控制 `zellij_pty_request_sudo`:`"hide"` 移除 tool,`"deny"` 保留但每次都拒絕呼叫,`"allow"`(預設)是正常 tool。
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts)

**`pty.cleanupExitedPaneOnRead`** `boolean`,預設 `true`。為 `true` 時,`zellij_pty_read` 對已退出的 pane 回傳 output 後會關閉該 pane。
**Spec:** [`src/tools/read.test.ts`](src/tools/read.test.ts) · [`src/config.test.ts`](src/config.test.ts)

**`tabTitle.enabled`** `boolean`,預設 `true`。設為 `false` 時停用動態 tab title。
**Spec:** [`tests/integration/plugin-load.test.ts`](tests/integration/plugin-load.test.ts) · [`src/config.test.ts`](src/config.test.ts)

**`tabTitle.emojiIdle` / `emojiRunning` / `emojiNeedsInput` / `emojiBranch`** 字串,預設 `🟢` / `⚡` / `💬` / `🌱`。狀態與 branch 區段的前綴。
**Spec:** [`tests/e2e/zellij-tab-title.run.test.ts`](tests/e2e/zellij-tab-title.run.test.ts) · [`src/zellij/tab-title-formatter.test.ts`](src/zellij/tab-title-formatter.test.ts)

**`tabTitle.debounceMs`** `number`,預設 `300`。tab title 更新的 debounce 時間(毫秒)。
**Spec:** [`src/zellij/tab-title.test.ts`](src/zellij/tab-title.test.ts)

### 範例

```jsonc
// .opencode/opencode-zellij.config.jsonc
{
  "$schema": "https://unpkg.com/opencode-zellij/opencode-zellij.schema.json",
  "pty": {
    "sudoPane": "deny"
  },
  "tabTitle": {
    "emojiRunning": "🔥",
    "emojiNeedsInput": "❓"
  }
}
```

`opencode-zellij.schema.json` 由 `src/config.ts` 產生,支援 JSON Schema 的編輯器可拿來做自動完成與驗證。
**Spec:** [`tests/integration/config-schema.test.ts`](tests/integration/config-schema.test.ts)
