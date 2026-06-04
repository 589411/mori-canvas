# foss-whiteboard-spike

一個**自架、零授權成本(全 MIT)**的會議白板:**講話 / 貼逐字稿 → AI agent 自動整理成便利貼 + 連線 → 多人即時協作的白板**。人也能在同一張板上拖拉、改字、連線、刪除,所有動作即時同步。

```
會議語音 ──mori-ear STT──▶ 逐字稿 ──Groq/qwen3 agent──▶ 便利貼+連線 ──yjs──▶ 多人 live 白板
                                                          人也能在同一張板上 拖拉 / 改字 / 連線 / 刪除
```

![agent board](docs/agent-board.png)

上圖整張板是把一段會議逐字稿丟給 AI 後**自動長出來**的:便利貼按性質上色(主題=黃、決議=藍、待辦=綠、風險=紅),箭頭表示關係。

---

## 怎麼運作(先看這個就懂要裝什麼)

這是 **client–server** 架構,**所有重活都跑在「主機」這一台**,其他人只是用瀏覽器連進來:

```
        主機(你的電腦,跑整套)                          其他人(只要瀏覽器)
  ┌─────────────────────────────────┐
  │  Vite (網頁 + 反向代理) :5174    │◀───── 手機 / 同事的筆電
  │     │ /api   │ /sync(ws)         │       (開瀏覽器連這台,零安裝)
  │     ▼        ▼                    │
  │  sync server :1234 (loopback)    │
  │     ├─ 即時同步 (yjs)             │
  │     ├─ agent  → Groq / qwen3      │  ← 用你的 Groq key
  │     └─ 語音   → mori-ear (STT)    │  ← 用你的 mori-ear
  └─────────────────────────────────┘
```

- **AI 整理(打字/貼逐字稿 → 便利貼)**:靠雲端 **Groq `gpt-oss-120b`**(本機 Ollama `qwen3` 當斷線後備)。
- **語音轉文字**:靠 **mori-ear**(走本機 whisper-server,或 Groq Whisper)。
- **即時同步**:自寫的 yjs sync server(不依賴任何雲服務)。
- 它**不是建構在 AgentOS 上**。跟 mori 生態的唯一關聯是:語音用 `mori-ear` CLI、Groq key 讀共用的 `~/.mori/config.json`。其餘是獨立的 FOSS app。

---

## 需要裝什麼

### A. 主機(跑整套的那台)

| 要件 | 用途 | 必要性 |
|---|---|---|
| **Node.js 18+** + npm | 跑 server 與前端 | 必要 |
| `npm install`(一次) | 自動拉好所有 JS 套件(yjs/konva/react/vite/express…) | 必要 |
| **Groq API key** 寫在 `~/.mori/config.json` 的 `providers.groq.api_key` | 「逐字稿 → 便利貼」的 AI | agent 必要 |
| **mori-ear** CLI(`~/.cargo/bin/mori-ear`)+ whisper(本機 whisper-server,或讓 ear 走 Groq Whisper) | 「錄音 → 文字」 | 只有要語音才需要 |
| **openssl** | 產自簽憑證給「公司區網版」用 | 只有要 HTTPS 區網才需要 |
| 麥克風 | 主機自己要錄的話 | 選用 |
| Ollama + `qwen3`(`ollama serve`) | Groq 連不到時的本機後備 | 選用 |

> **只想打字不想語音?** 那只要 Node + `npm install` + Groq key 就能跑(打字/貼逐字稿 → 便利貼)。`mori-ear` 只有錄音才用得到。

### B. 其他人(區網連進來協作)

**什麼都不用裝。** 只要:
1. 跟主機同一個 wifi / 區網
2. 一個現代瀏覽器(Chrome / Safari / Edge / Firefox)
3. 開主機給的網址,第一次接受一次自簽憑證警告;要錄音就允許麥克風

不用 Node、不用裝 App、不用 mori-ear、不用 Groq key。他們錄的音會傳到**主機**用**主機的** mori-ear + Groq 處理,**不耗他們自己任何資源**。

---

## 跑起來

```bash
npm install            # 第一次
```

### 1) 只在本機自己玩

```bash
npm run dev            # sync server(loopback :1234)+ Vite(:5174)
```
開 `http://localhost:5174/?room=meet`。

### 2) 公司區網版(多裝置 / 手機也能錄音)

這個版本把網頁跑在 **HTTPS** 上,這樣**手機/平板才能用麥克風**(瀏覽器規定麥克風只在 HTTPS 或 localhost 才給用)。架構上 sync server 縮在 loopback,只有 **HTTPS 的 5174** 對外。

**第一次設定(一行搞定:裝依賴 + 自動偵測本機 IP + 產含該 IP 的自簽憑證):**
```bash
npm run setup        # = bash setup.sh
```
(憑證放 `certs/`,已 gitignore。換了網路/IP 變了,重跑一次 `npm run setup` 即可。)

**啟動:**
```bash
npm run dev:lan        # sync loopback + Vite HTTPS(:5174)
```

**大家連:**
```
https://你的區網IP:5174/?room=meet        # 手機跟筆電都用這個(注意是 https)
```
- 每台**第一次**會跳「您的連線不是私人連線」→ 進階 →「繼續前往(不安全)」(這是你自己機器的憑證,點過去即可,**一次接受涵蓋頁面+同步+錄音**)。
- 進去後:兩台同一張板即時同步;按 **● 錄音** → 允許麥克風 → 講話 → 卡片冒出來,大家都看到 Mori 畫。
- 多人同時錄沒問題:卡片會累積、自動去重、不互蓋(server 有 per-room 序列化鎖)。

**安全 / 收尾**
- 對外只剩 HTTPS 的 5174;但**沒鑑權**,同 wifi 拿到網址 + 接受憑證的人就能進、會用到你的 Groq。內網信任場合 OK,**試完記得關**。
- 想加鎖:啟動前設 `WB_API_KEY=xxx`(API 要帶 `X-API-Key`)、`ALLOWED_ORIGINS=https://...`(收緊 CORS)。
- 收掉:`kill $(lsof -ti tcp:1234) $(lsof -ti tcp:5174)`。

---

## 操作

- **開會(主要用法)**:左下「**● 開始會議記錄**」→ 連續收音,**講一段、停頓一下就自動斷句**送轉錄 + AI 整理上板,整場 hands-free;「停止記錄」結束。也可「單次錄一段」或貼逐字稿按「丟給 agent」。
- **板上互動**:雙擊空白新增、雙擊便利貼改字、拖拉移動、連線模式點兩張連線、選便利貼/連線後 Delete 刪除、Ctrl+Z 復原、空白拖曳平移、滾輪/雙指縮放、回正。
- **分享 / QR**:工具列「分享 / QR」→ 設**你的名字**、顯示**房號**(短代碼)+ **QR**(手機掃了直接進)+ 連結 + 進行中房間清單。沒掃的人直接輸入房號也能進。分享網址自動用主機**區網 IP**(放 nginx 後面則自動是 nginx 網址)。開無 `?room` 的網址會自動產新房號。
- **會議摘要**:工具列「會議摘要」→ AI 把整張板整理成一頁會議紀錄(重點/決議/待辦+負責人/風險)。另有 **匯出 MD / PNG**。
- **房間管理**:分享面板可看進行中房間、進入別房、**結束此房**(清空)。

CLI / API(server 內部在 :1234,client 經 Vite 同源代理 `/api`、`/sync`):
```bash
npm run bot -- "外部寫的" meet blue                 # 外部 yjs peer 直接寫一張
curl -X POST localhost:1234/api/agent/meet -H 'Content-Type: application/json' \
  -d '{"transcript":"今天開會討論…"}'                # 逐字稿 → 板
curl localhost:1234/api/export/meet                  # 匯出 markdown
```

---

## 功能一覽

- **AI 整理**:逐字稿 → Groq `gpt-oss-120b`(qwen3 後備)→ 便利貼(按 kind 上色)+ 關係連線。**累積 + 智慧合併**:餵現有便利貼給 agent,只加新重點不重複;**op-based** 還能改寫/合併/刪除既有卡(決議翻案、待辦完成時板不會只進不出)。
- **連續會議記錄**:VAD 靜音自動斷句,整場語音邊講邊上板(hands-free)。
- **Speaker attribution**:設名字後,卡片標「誰提的」、游標顯示真名。
- **Mori 是看得見的參與者**:agent 寫卡時 yjs awareness 廣播 Mori 游標,卡片串流冒出、畫完離開;人類彼此游標也即時可見(下圖綠色標籤)。
- **會議摘要 + 匯出**:一頁 markdown 會議紀錄(含負責人)/ 匯出 MD / PNG。
- **房間 + 分享**:自動房號、QR、輸入房號加入、房間清單、結束此房。
- **持久化**:每房 `.data/<room>.bin`,重啟自動還原(含 SIGTERM/SIGINT flush)。
- **多裝置 / 手機**:同源代理 + 自簽 HTTPS(`npm run dev:lan`),手機可看可編可錄;responsive UI + 雙指縮放。
- **硬化 / 隱私 / 部署**:per-IP rate-limit、選用 `WB_API_KEY`、`LLM_LOCAL_ONLY=1`(逐字稿不出內網)、`deploy/` 內 systemd + nginx 反代範例。

![presence](docs/presence.png)

---

## 架構 / 檔案

| 部件 | 檔案 | 說明 |
|---|---|---|
| sync server | `server/sync-server.ts` | 自寫 classic-yjs 協定(`y-protocols`+`lib0`);agent/voice/bot/export endpoints;持久化;per-room 鎖;Mori 游標 |
| LLM cascade | `server/llm.ts` | Groq(`gpt-oss-120b`)→ Ollama(`qwen3`)後備;key/model 讀共用 `~/.mori/config.json` |
| agent | `server/agent.ts` | 逐字稿 → board plan;累積/合併;JSON 寬鬆解析 |
| STT | `server/stt.ts` | 委派 `mori-ear --input`(吃 wav/mp3/webm) |
| client | `client/src/App.tsx` | yjs + WebsocketProvider 同步 → react-konva 渲染;全部互動 + 錄音/agent 面板 |
| 反向代理 / HTTPS | `vite.config.ts` | `/api`+`/sync(ws)` 代理到 loopback 的 :1234;`HTTPS=1` 時用 `certs/` 跑 HTTPS |

---

## 踩過的雷(寫給下一棒)

1. **`@y/websocket-server`(yjs v3 官方推薦 server)不能用 classic yjs client 寫** —— 它依賴 fork `@y/y`,client→server 寫會噴 `store.getClock is not a function`。解法:自寫 classic-yjs server(本 repo `sync-server.ts`)。
2. **非 ASCII 房名要 `decodeURIComponent`**:WS 路徑沒 decode 而 `/api/:room` 被 express 自動 decode → `會議室甲` 變成兩個房,曾害「agent 說 6 張卻畫面空白」。
3. **手機錄音要 HTTPS**:`http://<區網IP>` 是不安全來源,瀏覽器擋 `getUserMedia`。所以才有「公司區網版」的自簽 HTTPS。
4. **React StrictMode + cleanup `provider.destroy()` 會殺連線** → 本 spike 拿掉 StrictMode。
5. **agent JSON**:gpt-oss/qwen3 會夾 `<think>`/圍欄,要先剝再取外層 `{...}`;qwen3 記得 `think:false`;connector 用 `{from,to}` 別用 `[[a,b]]`(模型會黏成 `["01"]`)。
6. **mori-ear**:`--input` batch 不卡 single-instance lock(daemon 在跑也能用);HTTP `/inference` 只吃 WAV,CLI 才吃 webm/mp3,所以走 CLI 最通用。
7. **server 重啟丟資料**:debounce 寫盤 + `tsx watch`/Ctrl-C → 要 SIGTERM/SIGINT flush(已做)。

---

## 路線圖

進度與待辦清單見 [`docs/BACKLOG.md`](docs/BACKLOG.md)(逐項 `[x]/[~]` 對應 git log)。

**已完成**:即時串流轉錄(VAD,門檻待真機微調)、agent op-based(改寫/合併/刪除)、speaker、會議摘要、房間管理+分享 QR、手機 UI、rate-limit、本機 LLM 開關、systemd+nginx。

**還沒做**:connector 方向語意上色+標籤;room 數上限;持久化改增量 append log;同一張便利貼欄位級並發(目前整顆 LWW);真憑證(免接受自簽)。

---

## 現況 / 授權

- **現況**:可玩的 spike,跑在開發機上(臨時程序 + in-memory + `.data/` 檔)。本機 git 版控(尚未 push 任何 remote)。**不是正式部署**:主機關掉/睡眠就停(板會留在 `.data/`,重開還在)。
- **授權**:核心依賴(yjs / y-protocols / lib0 / ws / konva / react-konva / react / express / vite)全 **MIT** —— 可閉源、可賣,**沒有 tldraw 那顆 production license**。語音那塊綁 `mori-ear`(你的工具),搬到別的機器要自己接 STT。
