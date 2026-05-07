# opencode-zellij

[English](README.md)

讓 OpenCode 可以使用可見的 Zellij panes，處理不適合消失在一次性 tool call 裡的工作。

一般 commands 請使用 OpenCode 內建的 `bash`。當 process 應該持續存在、保持可見，或需要後續輸入時，才使用這個 plugin。

## 安裝

把 npm package name 加到 OpenCode config：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-zellij"
  ]
}
```

OpenCode 會在啟動時自動安裝 npm plugins。Zellij 也必須已安裝，且可在 `PATH` 中使用。

## 適合情境

- dev servers 與 watchers
- REPLs 與互動式 CLIs
- SSH 或 remote sessions
- 會詢問後續問題的 commands
- 需要人類審核的 privileged commands

## 可以這樣要求 OpenCode

```text
在可見的 Zellij pane 中啟動 dev server，並等待它 ready。
```

```text
檢查 server pane 有沒有錯誤。
```

```text
對互動式 pane 送出 Enter，然後顯示最新 output。
```

```text
為 sudo install step 開一個 human-reviewed pane。
```

```text
關閉 dev server pane。
```

## Tools

| Tool | 用途 |
| --- | --- |
| `zellij_pty_spawn` | 啟動可見的 Zellij pane。 |
| `zellij_pty_read` | 讀取最近的 pane output。 |
| `zellij_pty_write` | 對互動式 pane 送出 input。 |
| `zellij_pty_list` | 顯示 plugin 已知的 panes。 |
| `zellij_pty_kill` | 關閉 plugin 建立的 pane。 |
| `zellij_pty_request_sudo` | 請使用者在 Zellij 中審核並執行 privileged commands。 |

## Human-only work

`zellij_pty_request_sudo` 會開啟 review pane、顯示即將執行的內容，並等待使用者輸入 `YES`。Agent 不能在該 pane 中輸入，因此 passwords 與 credentials 會留在 Zellij，而不是進入 prompts 或 tool arguments。

## 注意事項

- 這不是 sandbox。
- Session records 只存在於 memory；重啟 OpenCode 後會遺失。
- Output 是 rendered Zellij output，不是 raw PTY bytes。
- 由 plugin 啟動的 commands 會 best-effort 捕捉 exit code。
