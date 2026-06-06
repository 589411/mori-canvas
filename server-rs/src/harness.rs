//! 聚合整理 harness —— 為小模型(也為大模型減噪)設計的流水線。
//!
//! 原則:小模型做不好「一個 prompt 七件事」(舊 board-agent 的 intent 分類+指涉解析+
//! 去重+frame 選擇+複雜 JSON),但能做好「一個 prompt 一件事、輸出空間極小」。拆成:
//!
//! ```text
//! 語音段 → ① gate(三選一: command/content/noise)        ← 每段即跑
//!            ├ command → 既有完整 agent 路徑(指令不能等)
//!            ├ noise   → 丟棄(逐字稿仍保留)
//!            └ content → rolling buffer
//! buffer 觸發(靜默 SILENCE_FLUSH_SECS 秒 / 累積 MAX_BUFFER_CHARS 字 / ② 話題轉換)
//!         → ③ distill(整段 buffer → 1~3 個重點,輸出即卡片格式)
//!         → ④ dedup(逐個重點 vs 既有卡: new/update/skip)
//!         → apply_plan → yjs 廣播(現成機制,天然支援非同步)
//! ```
//!
//! frame 選擇是規則(最後一張卡所在的圖),不花 LLM。每次 flush 最多 1+3 次小呼叫。
//! 卡片會比「即時逐段」晚數十秒出現 —— 換來的是看完整段語意再壓縮,
//! 解決「講很多但只有一兩個重點」的噪音卡問題。設定頁可切回即時模式。
use crate::agent::{self, BoardPlan, StickyPlan, StickyUpdate};
use crate::llm::{chat, LlmOpts, Msg};
use crate::sync::Room;
use crate::{apply, glossary, store};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const SILENCE_FLUSH_SECS: u64 = 8; // 全場安靜這麼久 → 蒸餾上板
pub const MAX_BUFFER_CHARS: usize = 300; // 累積到這麼多字 → 直接蒸餾
const IDLE_REAP_SECS: u64 = 900; // 房間閒置這麼久 → 收掉 watcher

/// flush 需要的環境快照(背景 task 用,settings 變更下一段生效)
#[derive(Clone)]
struct Ctx {
    room: Arc<Room>,
    local_only: bool,
    auto_tidy: bool,
    spacing: f64,
    llm: LlmOpts,
}

/// buffer 裡的一段話;focus = 這段是「對著某張卡」講但跑題的內容
/// (flush 長出新卡時,會自動連回那張來源卡)
#[derive(Clone)]
struct Seg {
    line: String, // "發言人:內容"
    focus: Option<String>,
}

struct Buf {
    segs: Vec<Seg>,
    chars: usize,
    last_add: Instant,
    watched: bool, // 已有 watcher task 在看著
    ctx: Ctx,
}
impl Buf {
    fn drain(&mut self) -> Vec<Seg> {
        self.chars = 0;
        std::mem::take(&mut self.segs)
    }
    fn text(&self) -> String {
        self.segs.iter().map(|s| s.line.as_str()).collect::<Vec<_>>().join("\n")
    }
}

static BUFS: Lazy<Mutex<HashMap<String, Buf>>> = Lazy::new(|| Mutex::new(HashMap::new()));

// ── 解析(純函式,可測)───────────────────────────────────────────────

fn parse_gate(raw: &str) -> &'static str {
    match agent::extract_json(raw).and_then(|o| o.get("kind").and_then(|k| k.as_str()).map(String::from)).as_deref() {
        Some("command") => "command",
        Some("noise") => "noise",
        _ => "content", // 解析不出來 → 當 content,寧可進 buffer 也不丟內容
    }
}

fn parse_card_route(raw: &str) -> &'static str {
    match agent::extract_json(raw).and_then(|o| o.get("route").and_then(|k| k.as_str()).map(String::from)).as_deref() {
        Some("edit") => "edit",
        Some("offtopic") => "offtopic",
        _ => "discuss", // 拿不準 → 記成討論(寧可記下來,不要亂改卡或亂開新卡)
    }
}

fn parse_shift(raw: &str) -> bool {
    agent::extract_json(raw).and_then(|o| o.get("shift").and_then(|s| s.as_bool())).unwrap_or(false)
}

#[derive(Clone, Debug)]
pub struct Point {
    pub text: String,
    pub color: String,
    pub owner: Option<String>,
    pub tags: Option<Vec<String>>,
}

fn parse_points(raw: &str) -> Vec<Point> {
    let Some(obj) = agent::extract_json(raw) else { return vec![] };
    let Some(arr) = obj.get("points").and_then(|p| p.as_array()) else { return vec![] };
    arr.iter()
        .filter_map(|x| {
            let text: String = x.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(40).collect();
            if text.is_empty() {
                return None;
            }
            let color = x.get("kind").and_then(|v| v.as_str()).and_then(agent::color_by_kind).unwrap_or("yellow").to_string();
            let owner = x.get("owner").and_then(|v| v.as_str()).map(|s| s.trim().chars().take(10).collect::<String>()).filter(|s| !s.is_empty());
            let tags = x
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str()).filter(|t| !t.trim().is_empty()).take(2).map(|t| t.trim().chars().take(8).collect::<String>()).collect::<Vec<_>>())
                .filter(|v: &Vec<String>| !v.is_empty());
            Some(Point { text, color, owner, tags })
        })
        .take(3)
        .collect()
}

#[derive(Debug, PartialEq)]
enum Dedup {
    New,
    Update(usize),
    Skip,
}

fn parse_dedup(raw: &str, existing_count: usize) -> Dedup {
    let Some(obj) = agent::extract_json(raw) else { return Dedup::New };
    let idx = obj.get("index").and_then(|i| i.as_i64()).filter(|i| *i >= 0 && (*i as usize) < existing_count).map(|i| i as usize);
    match (obj.get("action").and_then(|a| a.as_str()), idx) {
        (Some("update"), Some(i)) => Dedup::Update(i),
        (Some("skip"), _) => Dedup::Skip,
        _ => Dedup::New, // 拿不準/索引爆界 → 當新卡(重複比遺漏好修)
    }
}

pub(crate) fn color_zh(c: &str) -> &'static str {
    match c {
        "yellow" => "主題",
        "green" => "待辦",
        "blue" => "決議",
        "red" => "風險",
        _ => "其他",
    }
}

// ── LLM 各階段(每個一件事)───────────────────────────────────────────

async fn gate(text: &str, local_only: bool, llm: &LlmOpts) -> &'static str {
    let msgs = [Msg { role: "system", content: crate::prompts::prompt("gate") }, Msg { role: "user", content: format!("使用者這段話:「{}」", text) }];
    match chat(&msgs, true, local_only, llm).await {
        Ok((out, _)) => parse_gate(&out),
        Err(_) => "content", // gate 掛了不丟內容
    }
}

/// 字卡語音的三分流:這段話是要「改這張卡」「討論這張卡」還是「跑題」?
pub async fn card_route(transcript: &str, card_text: &str, card_kind_zh: &str, local_only: bool, llm: &LlmOpts) -> &'static str {
    let user = format!("這張卡片:「{}」(類型:{})\n\n使用者這段話:「{}」", card_text, card_kind_zh, transcript);
    let msgs = [Msg { role: "system", content: crate::prompts::prompt("card-gate") }, Msg { role: "user", content: user }];
    match chat(&msgs, true, local_only, llm).await {
        Ok((out, _)) => parse_card_route(&out),
        Err(_) => "discuss", // 分流掛了 → 至少記下來
    }
}

async fn topic_shifted(buffer_text: &str, new_seg: &str, local_only: bool, llm: &LlmOpts) -> bool {
    let user = format!("目前累積中的討論片段:\n\"\"\"\n{}\n\"\"\"\n\n新的一段話:「{}」", buffer_text, new_seg);
    let msgs = [Msg { role: "system", content: crate::prompts::prompt("topicshift") }, Msg { role: "user", content: user }];
    match chat(&msgs, true, local_only, llm).await {
        Ok((out, _)) => parse_shift(&out),
        Err(_) => false,
    }
}

async fn distill(text: &str, room: &Room, local_only: bool, llm: &LlmOpts) -> Vec<Point> {
    let (_, topic) = store::read_meta(room);
    let topic_block = if topic.is_empty() { String::new() } else { format!("\n會議主題:「{}」", topic) };
    let (gl, _) = store::read_glossary(room);
    let gblock = glossary::agent_block(&gl);
    let user = format!("會議討論(累積的幾段話,格式「發言人:內容」):\n\"\"\"\n{}\n\"\"\"{}{}", text, topic_block, gblock);
    let msgs = [Msg { role: "system", content: crate::prompts::prompt("distill") }, Msg { role: "user", content: user }];
    match chat(&msgs, true, local_only, llm).await {
        Ok((out, _)) => parse_points(&out),
        Err(e) => {
            eprintln!("[harness] distill 失敗({e}),這批內容只留在逐字稿");
            vec![]
        }
    }
}

async fn dedup_one(p: &Point, existing_listing: &str, existing_count: usize, local_only: bool, llm: &LlmOpts) -> Dedup {
    if existing_count == 0 {
        return Dedup::New;
    }
    let user = format!("新重點:「{}」(類型:{})\n\n白板既有卡片(索引: [類型] 文字):\n{}", p.text, color_zh(&p.color), existing_listing);
    let msgs = [Msg { role: "system", content: crate::prompts::prompt("dedup") }, Msg { role: "user", content: user }];
    match chat(&msgs, true, local_only, llm).await {
        Ok((out, _)) => parse_dedup(&out, existing_count),
        Err(_) => Dedup::New,
    }
}

// ── frame 規則(不花 LLM)────────────────────────────────────────────

fn pick_frame(room: &Room, existing: &[agent::ExistingCard]) -> String {
    // 最後一張卡所在的圖:討論大多延續同一張圖;要換圖是 command(走完整路徑)
    if let Some(fid) = existing.iter().rev().find_map(|c| c.frame_id.clone()) {
        return fid;
    }
    if let Some(f) = store::frames_sorted(room).first() {
        return f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    }
    let (mtype, topic) = store::read_meta(room);
    let title: &str = if topic.is_empty() { crate::board_types::board_type(&mtype).label } else { &topic };
    let f = store::create_frame(room, &mtype, title);
    f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

// ── flush:buffer → 蒸餾 → 去重 → 上板 ───────────────────────────────

async fn flush(room_name: String, ctx: Ctx, segs: Vec<Seg>) {
    if segs.is_empty() {
        return;
    }
    let text = segs.iter().map(|s| s.line.as_str()).collect::<Vec<_>>().join("\n");
    // 這批內容若是「對著某張卡」跑題長出來的,記住來源卡,等下自動連線
    let focus: Option<String> = segs.iter().rev().find_map(|s| s.focus.clone());
    let points = distill(&text, &ctx.room, ctx.local_only, &ctx.llm).await;
    if points.is_empty() {
        return;
    }
    // 讀板、比對、寫板都在 room lock 內,跟其他 agent turn 互斥
    let lk = crate::room_lock(&room_name).await;
    let _g = lk.lock().await;
    let existing = apply::existing_stickies(&ctx.room);
    let listing: String = existing.iter().enumerate().map(|(i, c)| format!("{}: [{}] {}", i, color_zh(&c.color), c.text)).collect::<Vec<_>>().join("\n");
    let mut plan = BoardPlan { stickies: vec![], connectors: vec![], updates: vec![], deletes: vec![], frame: None };
    for p in &points {
        match dedup_one(p, &listing, existing.len(), ctx.local_only, &ctx.llm).await {
            Dedup::New => plan.stickies.push(StickyPlan { text: p.text.clone(), color: p.color.clone(), owner: p.owner.clone(), tags: p.tags.clone() }),
            Dedup::Update(i) => plan.updates.push(StickyUpdate { index: i, text: Some(p.text.clone()), color: Some(p.color.clone()) }),
            Dedup::Skip => {}
        }
    }
    if plan.stickies.is_empty() && plan.updates.is_empty() {
        return;
    }
    let frame_id = pick_frame(&ctx.room, &existing);
    let existing_ids: Vec<String> = existing.iter().map(|c| c.id.clone()).collect();
    let (ids, _drawn) = apply::apply_plan(&ctx.room, &plan, "Mori", &existing_ids, Some(&frame_id)).await;
    // 跑題內容長出的新卡 → 自動連回來源卡(討論是從那張卡岔出去的)
    if let Some(src) = focus.filter(|f| existing_ids.iter().any(|id| id == f)) {
        for nid in &ids {
            apply::connect_ids(&ctx.room, &src, nid);
        }
    }
    if ctx.auto_tidy && (!ids.is_empty() || !plan.updates.is_empty()) {
        apply::tidy_board(&ctx.room, ctx.spacing);
    }
}

/// watcher:每 2 秒看一次這個房的 buffer,靜默逾時就 flush;閒置太久收攤
async fn watch_loop(room_name: String) {
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let job = {
            let mut bufs = BUFS.lock().await;
            let Some(b) = bufs.get_mut(&room_name) else { break };
            if b.segs.is_empty() {
                if b.last_add.elapsed() > Duration::from_secs(IDLE_REAP_SECS) {
                    bufs.remove(&room_name);
                    break;
                }
                None
            } else if b.last_add.elapsed() >= Duration::from_secs(SILENCE_FLUSH_SECS) {
                Some((b.drain(), b.ctx.clone()))
            } else {
                None
            }
        };
        if let Some((segs, ctx)) = job {
            flush(room_name.clone(), ctx, segs).await;
        }
    }
}

// ── 入口:每個語音段呼叫一次 ─────────────────────────────────────────

/// 回傳值直接當 HTTP 回應(立即回,卡片由背景 flush 經 yjs 廣播)
pub async fn ingest(room_name: &str, room: Arc<Room>, transcript: &str, by: &str, local_only: bool, auto_tidy: bool, spacing: f64, llm: &LlmOpts) -> Value {
    match gate(transcript, local_only, llm).await {
        "command" => {
            // 指令不能等:走既有完整 agent 路徑(指令處理它本來就擅長)
            let lk = crate::room_lock(room_name).await;
            let _g = lk.lock().await;
            match apply::run_agent_turn(&room, transcript, by, local_only, auto_tidy, spacing, llm).await {
                Ok(v) => v,
                Err(e) => json!({ "ok": false, "error": e }),
            }
        }
        "noise" => json!({ "ok": true, "intent": "noise", "stickies": 0, "connectors": 0 }),
        _ => buffer_content(room_name, room, transcript, by, None, local_only, auto_tidy, spacing, llm).await,
    }
}

/// 把一段「會議內容」放進房間 buffer(gate 已判定/或來源已知是內容)。
/// `focus` = 這段是對著某張卡講但跑題的內容,flush 長新卡時會自動連回它。
#[allow(clippy::too_many_arguments)]
pub async fn buffer_content(room_name: &str, room: Arc<Room>, transcript: &str, by: &str, focus: Option<String>, local_only: bool, auto_tidy: bool, spacing: f64, llm: &LlmOpts) -> Value {
    let seg = Seg { line: format!("{}:{}", by, transcript.trim()), focus };
    let ctx = Ctx { room: room.clone(), local_only, auto_tidy, spacing, llm: llm.clone() };
    // 1) 快照目前 buffer(鎖內不打 LLM)
    let buffer_text = {
        let bufs = BUFS.lock().await;
        bufs.get(room_name).map(|b| b.text()).unwrap_or_default()
    };
    // 2) 話題轉換偵測(buffer 非空才需要)
    let shifted = !buffer_text.is_empty() && topic_shifted(&buffer_text, transcript, local_only, llm).await;
    // 3) 進 buffer;決定要不要 flush
    let (old_batch, full_batch, buffered, spawn_watcher) = {
        let mut bufs = BUFS.lock().await;
        let b = bufs.entry(room_name.to_string()).or_insert_with(|| Buf { segs: vec![], chars: 0, last_add: Instant::now(), watched: false, ctx: ctx.clone() });
        b.ctx = ctx.clone(); // settings/byo 以最後一段為準
        let old = if shifted { Some(b.drain()) } else { None }; // 換話題:舊話先上板
        b.chars += seg.line.chars().count();
        b.segs.push(seg);
        b.last_add = Instant::now();
        let full = if b.chars >= MAX_BUFFER_CHARS { Some(b.drain()) } else { None };
        let watch = if b.watched { false } else { b.watched = true; true };
        (old, full, b.chars, watch)
    };
    if spawn_watcher {
        tokio::spawn(watch_loop(room_name.to_string()));
    }
    for batch in [old_batch, full_batch].into_iter().flatten() {
        let (rn, c) = (room_name.to_string(), ctx.clone());
        tokio::spawn(async move { flush(rn, c, batch).await });
    }
    json!({ "ok": true, "intent": "buffered", "queued": true, "buffered": buffered, "shifted": shifted, "stickies": 0, "connectors": 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_parses_three_kinds_and_defaults_to_content() {
        assert_eq!(parse_gate(r#"{"kind":"command"}"#), "command");
        assert_eq!(parse_gate(r#"{"kind":"noise"}"#), "noise");
        assert_eq!(parse_gate(r#"{"kind":"content"}"#), "content");
        assert_eq!(parse_gate("亂回一通"), "content"); // 解析失敗不丟內容
        assert_eq!(parse_gate(r#"{"kind":"banana"}"#), "content");
    }

    #[test]
    fn card_route_parses_and_defaults_discuss() {
        assert_eq!(parse_card_route(r#"{"route":"edit"}"#), "edit");
        assert_eq!(parse_card_route(r#"{"route":"offtopic"}"#), "offtopic");
        assert_eq!(parse_card_route(r#"{"route":"discuss"}"#), "discuss");
        assert_eq!(parse_card_route("garbage"), "discuss"); // 拿不準 → 記下來最安全
    }

    #[test]
    fn shift_parses_and_defaults_false() {
        assert!(parse_shift(r#"{"shift":true}"#));
        assert!(!parse_shift(r#"{"shift":false}"#));
        assert!(!parse_shift("not json"));
    }

    #[test]
    fn points_sanitized_and_capped() {
        let raw = r#"{"points":[
            {"text":"線上預約系統","kind":"topic"},
            {"text":"報價單下週前完成","kind":"todo","owner":"阿明","tags":["業務","急","多的會被截"]},
            {"text":"","kind":"risk"},
            {"text":"資安疑慮","kind":"risk"},
            {"text":"第四點該被截掉","kind":"topic"}
        ]}"#;
        let pts = parse_points(raw);
        assert_eq!(pts.len(), 3); // 空 text 跳過、最多 3 點
        assert_eq!(pts[0].color, "yellow");
        assert_eq!(pts[1].color, "green");
        assert_eq!(pts[1].owner.as_deref(), Some("阿明"));
        assert_eq!(pts[1].tags.as_ref().unwrap().len(), 2); // tags 最多 2
        assert_eq!(pts[2].color, "red");
    }

    #[test]
    fn dedup_validates_index_and_defaults_new() {
        assert_eq!(parse_dedup(r#"{"action":"update","index":1}"#, 3), Dedup::Update(1));
        assert_eq!(parse_dedup(r#"{"action":"skip"}"#, 3), Dedup::Skip);
        assert_eq!(parse_dedup(r#"{"action":"new"}"#, 3), Dedup::New);
        assert_eq!(parse_dedup(r#"{"action":"update","index":9}"#, 3), Dedup::New); // 爆界 → new
        assert_eq!(parse_dedup("garbage", 3), Dedup::New);
    }

    #[test]
    fn buf_drain_resets() {
        // 不碰 LLM 的純狀態測試
        let mut segs = vec!["a:x".to_string(), "b:y".to_string()];
        let taken = std::mem::take(&mut segs);
        assert_eq!(taken.len(), 2);
        assert!(segs.is_empty());
    }
}
