# mori-canvas

> Mori 的共筆畫布(原 foss-whiteboard-spike)。Mori 宇宙的「會議白板」身體部件。

一個**自架、零授權成本(全 MIT)**的會議白板:**講話 / 貼逐字稿 → AI agent 自動整理成便利貼 + 連線 → 多人即時協作的白板**。人也能在同一張板上拖拉、改字、連線、刪除,所有動作即時同步。

```
會議語音 ──mori-ear STT──▶ 逐字稿 ──Groq/qwen3 agent──▶ 便利貼+連線 ──yjs──▶ 多人 live 白板
                                                          人也能在同一張板上 拖拉 / 改字 / 連線 / 刪除
```

![共筆白板](docs/hero.png)

上圖整張板是把一段會議逐字稿丟給 AI 後**自動長出來**的:便利貼按性質上色(主題=黃、決議=藍、待辦=綠、風險=紅),箭頭表示關係。

---

## 怎麼運作(先看這個就懂要裝什麼)

這是 **client–server** 架構,**所有重活(STT、AI、整理、白板狀態)都跑在「主機」這一台**,其他人只是用瀏覽器連進來(零安裝):

```
        主機(你的電腦,跑整套)                          其他人(只要瀏覽器)
  ┌──────────────────────────────────────┐
  │  Vite (網頁 + 反向代理) :5174         │◀───── 手機 / 同事的筆電
  │     │ /api   │ /sync(ws)              │       (開瀏覽器連這台,零安裝)
  │     ▼        ▼                         │
  │  sync server :1234 (loopback)         │
  │     ├─ 即時同步 (yjs CRDT)            │
  │     ├─ STT      → mori-ear (Whisper)  │  ← 用你的 mori-ear
  │     └─ agent(意圖判斷 + 整理/執行)    │  ← 用你的 Groq key
  │           └→ Groq gpt-oss-120b / qwen3│
  └──────────────────────────────────────┘
```

### 從「你講一句話」到「白板動作」的完整流程

1. **瀏覽器**:麥克風錄音,偵測靜音自動切一段 → 把音檔位元組 POST 給主機(`/api/voice`)。
2. **主機 · STT**:mori-ear(Whisper)把音檔轉成文字。
3. **主機 · AI**:把「這段文字」+「目前整張白板(每張卡的類型/負責人/標籤,帶索引)」一起丟給 LLM。LLM 先判斷這句是**指令(command)**還是**會議內容(content)**,回一個 JSON。
4. **主機 · 驗證 + 執行**(這層是寫死的規則,不是 AI):檢查 JSON 合法(索引在範圍、動作有效)。
   - 是**指令** → 直接執行:排版 / 篩選 / 指派負責人 / 改類型 / 加標籤 / 改寫文字。
   - 是**內容** → 整理成便利貼(配色、負責人、標籤、連線),或改/併/刪既有卡。
5. **同步回所有人**:白板變動透過 yjs(websocket)即時廣播給每一台瀏覽器;只影響「自己畫面」的指令(像篩選)則回傳給講話的那台套用。

所以 **理解與整理都在伺服端(主機)做,做完同步回網頁**;瀏覽器只負責「錄音 + 畫」——這也是同事零安裝的原因。判斷指令靠的是 **LLM 的理解,不是關鍵字比對**:例如「交給阿明做」會被當成指派(沒講「指派」)、「改寫成線上掛號」走改文字、「改成風險」走改類型。貼現成逐字稿走的是同一條路,只是跳過第 2 步 STT。

- **AI**:Groq `gpt-oss-120b`(本機 Ollama `qwen3` 後備),key/model 讀共用 `~/.mori/config.json`。
- **STT**:mori-ear(本機 whisper-server 或 Groq Whisper)。
- **即時同步**:自寫 yjs sync server(不靠任何雲服務)。
- 它**不是建構在 AgentOS 上**;跟 mori 生態的唯一關聯=`mori-ear` CLI + 共用 config。其餘是獨立 FOSS app。

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

## 語音(STT)三條路 —— ⚙ 設定裡切

白板可以**獨立運作、不一定要 mori-ear**(對「要賣給別人」很重要)。設定頁「處理方式」:

| 模式 | STT 怎麼來 | 適合 |
|---|---|---|
| **Mori 處理** | 委派 `mori-ear`(它自己決定本機 whisper / Groq);僅在偵測到 mori-ear 時可選 | 你自己、已裝 Mori |
| **自訂 · 雲端** | Groq Whisper API,填**自己的 Groq key** | 客戶**零安裝**,首選 |
| **自訂 · 本機** | 打一台本機 **whisper-server**(`/inference`);需自行安裝 | 不想資料出網 |

「自訂」模式由白板自己處理,且**送 STT 前會先做靜音剪**(ffmpeg),避免 Whisper 對靜音產生幻覺(例如硬掰出「(字幕製作:貝爾)」)。

**自訂 · 本機 要裝 whisper-server**(Linux):
```bash
sudo apt install build-essential cmake ffmpeg   # GPU 另加 nvidia-cuda-toolkit
bash scripts/setup-whisper-linux.sh             # 從源碼編 whisper-server,自動偵測 GPU/CPU
bash whisper/run-whisper.sh                      # 啟動在 127.0.0.1:8089
```
**Windows 更簡單**(whisper.cpp 有預編譯 release,GPU 的 cuBLAS 版自帶 CUDA runtime、免裝 toolkit):
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper-windows.ps1  # 偵測 GPU 抓對應預編 zip
powershell -ExecutionPolicy Bypass -File whisper\run-whisper.ps1            # 啟動在 127.0.0.1:8089
```
然後 ⚙ 設定 → 自訂 → 本機 whisper,網址填 `http://127.0.0.1:8089/inference`(留空則自動偵測 `~/.mori/whisper-server.json`)。`WHISPER_MODEL=large-v3-turbo` 可換大模型(GPU 才跑得動)。

---

## 跑起來

**後端是 Rust(`server-rs/`),一顆 binary 把前端 + API + 同步全包**(前端 `client/dist` 用 `include_dir` 內嵌進 binary,所以可從任意目錄跑)。也有 Tauri 桌面版(`src-tauri/`)。需要 Rust(`cargo`)+ Node(只用來 build 前端)。

```bash
npm install
npm run build          # = vite build(前端)→ cargo build --release(Rust binary,內嵌前端)
```

### 1) 只在本機自己玩

```bash
npm run dev            # 編 + 跑 debug binary;預設 http://0.0.0.0:1334
```
開 `http://localhost:1334/?room=meet`。

### 2) 公司區網版(多裝置 / 手機也能錄音)

手機/平板要用麥克風就得 **HTTPS**(瀏覽器規定)。Rust server **自己serve HTTPS**(`HTTPS=1` + `certs/`),不再需要 Vite。

**第一次設定(裝依賴 + 偵測本機 IP + 產含該 IP 的自簽憑證):**
```bash
npm run setup          # = bash setup.sh,憑證放 certs/(已 gitignore);換網路/IP 變了重跑一次
```

**啟動(HTTPS、:5174、對區網開放):**
```bash
npm run build          # 第一次 / 改過前端後
npm run start:lan      # = HTTPS=1 PORT=5174 BIND=0.0.0.0 ./server-rs/target/release/mori-canvas-server
```

**大家連:**
```
https://你的區網IP:5174/?room=meet        # 手機跟筆電都用這個(注意是 https)
```
- 每台**第一次**會跳「您的連線不是私人連線」→ 進階 →「繼續前往(不安全)」(自己機器的自簽憑證,點過去即可,**一次接受涵蓋頁面+同步+錄音**)。
- 進去後:同一張板即時同步;按 **● 錄音** → 允許麥克風 → 講話 → 卡片冒出來,大家都看到 Mori 一張張畫。
- 多人同時錄沒問題:per-room 序列化鎖,卡片累積、不互蓋。

**桌面版(Tauri):** `npm run tauri`(內嵌 server 跑 loopback :8731,開原生視窗;啟動會自我登記成 mori-desktop body part)。

**安全 / 收尾**
- 對外只有 HTTPS 的 5174;**沒鑑權**,同 wifi 拿到網址 + 接受憑證的人就能進、會用到你的 Groq。內網信任場合 OK,**試完記得關**。
- 生產建議擺 nginx 反向代理(Rust 縮 loopback、nginx 終結 TLS)。
- 收掉:`kill $(lsof -ti tcp:5174)`。

---

## 操作

- **開會(主要用法)**:左下「**● 開始會議記錄**」→ 連續收音,**講一段、停頓一下就自動斷句**送轉錄 + AI 整理上板,整場 hands-free;「停止記錄」結束。也可「單次錄一段」或貼逐字稿按「丟給 agent」。
- **板上互動**:雙擊空白新增、雙擊便利貼改字、拖拉移動、連線模式點兩張連線、選便利貼/連線後 Delete 刪除、Ctrl+Z 復原、空白拖曳平移、滾輪/雙指縮放、回正。
- **分享 / QR**:工具列「分享 / QR」→ 設**你的名字**、顯示**房號**(短代碼)+ **QR**(手機掃了直接進)+ 連結 + 進行中房間清單。沒掃的人直接輸入房號也能進。分享網址自動用主機**區網 IP**(放 nginx 後面則自動是 nginx 網址)。開無 `?room` 的網址會自動產新房號。
- **會議摘要**:工具列「會議摘要」→ AI 把整張板整理成一頁會議紀錄(重點/決議/待辦+負責人/風險)。另有 **匯出 MD / PNG**。
- **板型(metadata 驅動)**:工具列徽章可切板型 —— **會議白板 / 組織架構圖 / 流程圖 / 系統架構圖**。板型(type+topic 存在 yjs)決定 AI 怎麼解讀卡片與連線、怎麼配色、怎麼自動排版(會議=分欄;組織/流程/架構=沿連線的階層樹)。同一個引擎,換板型就畫不同的圖。
- **即時字幕**:錄音時辨識出的文字在畫面下方浮現 3 秒淡出(給說話的人 UX 提示)。
- **房間管理**:分享面板可看進行中房間、進入別房、**結束此房**(清空)。房間永久保留(`.data/<房號>.bin`),沒人連也在、重啟還原、無過期。

CLI / API(server 內部在 :1234,client 經 Vite 同源代理 `/api`、`/sync`):
```bash
npm run bot -- "外部寫的" meet blue                 # 外部 yjs peer 直接寫一張
curl -X POST localhost:1234/api/agent/meet -H 'Content-Type: application/json' \
  -d '{"transcript":"今天開會討論…"}'                # 逐字稿 → 板(一句一句)
curl localhost:1234/api/export/meet                  # 匯出 markdown
curl -X POST localhost:1234/api/visualize -H 'Content-Type: application/json' \
  -d '{"transcript":"整場逐字稿…"}'                  # 一次到位:整段逐字稿 → 建板 → 回 markdown/summary + 可繼續編輯的 url
```

> **AgentOS dispatch(選用)**:`/api/visualize` 同時是 `meeting.visualize` skill 的 http-service endpoint。
> server 啟動(桌面版,或 `MORI_CANVAS_REGISTER=1`)會寫 `~/.mori/mori-canvas-server.json`,讓 AgentOS
> `agentos run` 時把「傳一段會議逐字稿 → 產出白板 + 匯出」dispatch 進來。Standalone 行為不受影響。

---

## 功能一覽

- **AI 整理**:逐字稿 → Groq `gpt-oss-120b`(qwen3 後備)→ 便利貼(按 kind 上色)+ 關係連線。**累積 + 智慧合併**:餵現有便利貼給 agent,只加新重點不重複;**op-based** 還能改寫/合併/刪除既有卡(決議翻案、待辦完成時板不會只進不出)。
- **連續會議記錄**:VAD 靜音自動斷句,整場語音邊講邊上板(hands-free)。
- **語音指令(intent 判斷)**:agent 會分辨你這句是「會議內容」還是「指令」。講「幫我排一下 / 只看亞澤的 / 把這張指給小明 / 改成決議」會直接執行(排版/篩選/指派/改類型),不用找按鈕。agent 也吃得到目前每張卡的類型/負責人/標籤,所以「知道現況」。
- **負責人 + 標籤 + 篩選**:agent 抽負責人(amber chip)與內容標籤(#tag);點任一個只看該人/該標籤的卡。卡片 popover 有「語音」可直接口述該卡內容。
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

後端是 **Rust**(`server-rs/`,crate `mori-canvas-server`);前端 `client/` 內嵌進 binary。`server/`(舊 Node 版)已移除。

| 部件 | 檔案 | 說明 |
|---|---|---|
| sync server | `server-rs/src/sync.rs` | `yrs` + `yrs-warp` 多房同步(跟 yjs JS client 互通)+ 持久化 `.data/<room>.bin` |
| agent / LLM | `server-rs/src/agent.rs`, `llm.rs`, `apply.rs` | 逐字稿 → 意圖判斷 → board plan/指令;Groq(`gpt-oss-120b`)→ Ollama(`qwen3`);串流 Mori 游標 |
| 排版 / 板型 | `server-rs/src/layout.rs`, `board_types.rs` | 6 種排版(分欄/樹/放射/象限/魚骨/甘特)+ 10 種板型,frame-aware |
| STT | `server-rs/src/stt.rs` | Mori(委派 `mori-ear`)/ 自訂(Groq Whisper / 本機 whisper-server + ffmpeg 靜音剪) |
| HTTP / 服務 | `server-rs/src/lib.rs` (`serve`) | warp:`/api/*` + `/sync` ws + 內嵌前端;`HTTPS=1`+`certs/` 自帶 TLS;`BIND`/`PORT` 可調 |
| client | `client/src/App.tsx` | yjs + WebsocketProvider 同步 → react-konva 渲染;全部互動 + 錄音/agent 面板 + 畫板存檔/還原 |
| 桌面版 | `src-tauri/` | Tauri 2:內嵌 server + webview;啟動自我登記 mori-desktop body part |

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
