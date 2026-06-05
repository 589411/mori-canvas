mod agent;
mod apply;
mod board_types;
mod layout;
mod llm;
mod store;
mod stt;
mod sync;
mod yval;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::Filter;

// the built client is embedded into the binary => one self-contained file (also what
// the Tauri webview loads). Requires `npm run build` (client/dist) before cargo build.
static CLIENT_ASSETS: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../client/dist");
fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn sanitize_ext(s: &str) -> String {
    let e: String = s.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if e.is_empty() {
        "webm".into()
    } else {
        e
    }
}
async fn write_tmp(prefix: &str, ext: &str, body: &[u8]) -> String {
    let p = std::env::temp_dir().join(format!("{}-{}.{}", prefix, store::rid(), ext));
    let _ = tokio::fs::write(&p, body).await;
    p.to_string_lossy().to_string()
}

// mori-desktop BodyManifest self-register (like mori-meeting-recorder), OFF by default
// so we never autonomously write the shared ~/.mori/. Enable with MORI_CANVAS_REGISTER=1.
fn maybe_register_body_part(port: u16) {
    if std::env::var("MORI_CANVAS_REGISTER").as_deref() != Ok("1") {
        return;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.mori/body-parts/mori.canvas", home);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let manifest = json!({
        "schema_version": 1,
        "id": "mori.canvas",
        "name": "Mori Canvas",
        "kind": "local_service",
        "description": "會議共筆白板 — AI 把語音/逐字稿整理成便利貼+圖,多人即時協作。",
        "capabilities": ["whiteboard.collaborate", "meeting.visualize", "transcribe.local"],
        "entrypoints": { "web": format!("http://127.0.0.1:{}/", port) },
        "interfaces": [
            { "name": "api", "transport": "http", "base_url": format!("http://127.0.0.1:{}", port) },
            { "name": "sync", "transport": "ws", "url": format!("ws://127.0.0.1:{}/sync", port) }
        ],
        "permissions": [],
        "data_policy": { "owns_raw_data": true, "default_ingestion": "off" }
    });
    if std::fs::write(format!("{}/manifest.json", dir), serde_json::to_string_pretty(&manifest).unwrap()).is_ok() {
        println!("registered mori-desktop body part: {}/manifest.json", dir);
    }
    write_agentos_descriptor(port);
}

/// AgentOS 服務發現檔 `~/.mori/mori-canvas-server.json` —— 讓 AgentOS 在 dispatch `meeting.visualize`
/// (http-service / json 模式)時用 `forward_json` 找到本機 server、POST 到 `/api/visualize`。
/// 格式對齊 whisper-server 契約(AgentOS 的 descriptor 解析器只認 host/port/inference_path/contract_version);
/// 與 whisper-server.json / mori-recorder-server.json 並存不衝突。**呼叫端決定要不要寫**(standalone 路徑
/// 由 `MORI_CANVAS_REGISTER=1` gate;桌面 app 啟動即寫)。
pub fn write_agentos_descriptor(port: u16) {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return;
    }
    let dir = format!("{}/.mori", home);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let desc = json!({
        "contract_version": 1,
        "host": "127.0.0.1",
        "port": port,
        "pid": std::process::id(),
        "inference_path": "/api/visualize"
    });
    if std::fs::write(format!("{}/mori-canvas-server.json", dir), serde_json::to_string_pretty(&desc).unwrap()).is_ok() {
        println!("wrote AgentOS descriptor: {}/mori-canvas-server.json (port {})", dir, port);
    }
}

#[derive(Clone, serde::Serialize)]
struct Settings {
    spacing: f64,
    #[serde(rename = "autoTidy")]
    auto_tidy: bool,
    mode: String,       // mori | custom
    #[serde(rename = "sttSource")]
    stt_source: String, // cloud | local
    #[serde(rename = "localOnly")]
    local_only: bool,
    #[serde(rename = "whisperUrl")]
    whisper_url: String,
}
static SETTINGS: Lazy<Mutex<Settings>> = Lazy::new(|| {
    // capability-aware defaults: no mori-ear (e.g. on a cloud host) => custom/cloud (Groq Whisper)
    let caps = stt::stt_capabilities();
    let has_ear = caps.get("moriEar").and_then(|v| v.as_bool()).unwrap_or(false);
    let has_ws = caps.get("whisperServer").and_then(|v| v.as_bool()).unwrap_or(false);
    Mutex::new(Settings {
        spacing: 1.0,
        auto_tidy: true,
        mode: if has_ear { "mori" } else { "custom" }.into(),
        stt_source: if has_ws { "local" } else { "cloud" }.into(),
        local_only: false,
        whisper_url: String::new(),
    })
});

// ---- demo guards: per-IP rate limit + sponsor banner (env-driven, off unless set) ----
fn demo_rate_per_min() -> Option<u32> {
    std::env::var("DEMO_RATE_PER_MIN").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0)
}
static RATE_HITS: Lazy<Mutex<HashMap<String, Vec<std::time::Instant>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
fn client_ip(xff: &Option<String>) -> String {
    xff.as_ref().and_then(|s| s.split(',').next()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "?".into())
}
/// sliding 60s window; returns false (blocked) when over the per-minute limit. No limit set => always ok.
async fn rate_ok(ip: &str) -> bool {
    let limit = match demo_rate_per_min() {
        Some(n) => n as usize,
        None => return true,
    };
    let now = std::time::Instant::now();
    let mut m = RATE_HITS.lock().await;
    let hits = m.entry(ip.to_string()).or_default();
    hits.retain(|t| now.duration_since(*t).as_secs() < 60);
    if hits.len() >= limit {
        return false;
    }
    hits.push(now);
    true
}
fn sponsor_config() -> Value {
    let g = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
    json!({
        "sponsorUrl": g("SPONSOR_URL"),
        "sponsorLabel": g("SPONSOR_LABEL").unwrap_or_else(|| "贊助".into()),
        "demoNotice": g("DEMO_NOTICE"),
    })
}

fn lan_ip() -> Option<String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

fn with<T: Clone + Send>(t: T) -> impl Filter<Extract = (T,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || t.clone())
}

// visitor's "bring your own AI" override, from request headers (set client-side)
fn llm_opts() -> impl Filter<Extract = (llm::LlmOpts,), Error = warp::Rejection> + Clone {
    warp::header::optional::<String>("x-llm-base")
        .and(warp::header::optional::<String>("x-llm-key"))
        .and(warp::header::optional::<String>("x-llm-model"))
        .map(|base: Option<String>, key: Option<String>, model: Option<String>| llm::LlmOpts { base, key, model })
}

// frame-aware markdown export (port of /api/export)
fn export_markdown(room: &sync::Room) -> String {
    let shapes = store::read_map(room, "shapes");
    let conns = store::read_map(room, "connectors");
    let frames = store::frames_sorted(room);
    let (mtype, topic) = store::read_meta(room);
    let text = |id: &str| -> String {
        shapes
            .iter()
            .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id))
            .and_then(|s| s.get("text").and_then(|v| v.as_str()))
            .unwrap_or("?")
            .to_string()
    };
    let named = |s: &Value| -> String {
        if let Some(o) = s.get("owner").and_then(|v| v.as_str()) {
            return format!("({})", o);
        }
        match s.get("drawnBy").and_then(|v| v.as_str()) {
            Some(d) if !["user", "agent", "voice", "bot"].contains(&d) => format!("({})", d),
            _ => String::new(),
        }
    };
    let tagstr = |s: &Value| -> String {
        s.get("tags").and_then(|v| v.as_array()).map(|a| {
            let t: Vec<String> = a.iter().filter_map(|x| x.as_str()).map(|x| format!("#{}", x)).collect();
            if t.is_empty() { String::new() } else { format!(" {}", t.join(" ")) }
        }).unwrap_or_default()
    };
    let section = |heading: &str, type_key: &str, cards: &[&Value], hlevel: &str| -> String {
        let bt = board_types::board_type(type_key);
        let order = ["blue", "green", "yellow", "red"];
        let mut by_cat: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for s in cards {
            let color = s.get("color").and_then(|v| v.as_str()).unwrap_or("yellow");
            let cat = board_types::color_label(bt, color).unwrap_or("其他").to_string();
            by_cat.entry(cat).or_default().push(format!("- {}{}{}", s.get("text").and_then(|v| v.as_str()).unwrap_or(""), named(s), tagstr(s)));
        }
        let mut out = format!("{} {}\n", hlevel, heading);
        let mut cats: Vec<String> = order.iter().filter_map(|c| board_types::color_label(bt, c)).map(|s| s.to_string()).collect();
        cats.push("其他".to_string());
        for cat in cats {
            if let Some(items) = by_cat.get(&cat) {
                if !items.is_empty() {
                    out += &format!("\n**{}**\n{}\n", cat, items.join("\n"));
                }
            }
        }
        let ids: std::collections::HashSet<&str> = cards.iter().filter_map(|c| c.get("id").and_then(|v| v.as_str())).collect();
        let edges: Vec<String> = conns
            .iter()
            .filter(|c| {
                let f = c.get("from").and_then(|v| v.as_str()).unwrap_or("");
                let t = c.get("to").and_then(|v| v.as_str()).unwrap_or("");
                ids.contains(f) && ids.contains(t)
            })
            .map(|c| format!("- {} → {}", text(c.get("from").and_then(|v| v.as_str()).unwrap_or("?")), text(c.get("to").and_then(|v| v.as_str()).unwrap_or("?"))))
            .collect();
        if !edges.is_empty() {
            out += &format!("\n**{}**\n{}\n", bt.edge_label, edges.join("\n"));
        }
        out + "\n"
    };
    let mut md = String::new();
    if !frames.is_empty() {
        md = format!("# 會議白板:{}\n\n", if topic.is_empty() { "board".to_string() } else { topic.clone() });
        for f in &frames {
            let fid = f.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let ftype = f.get("type").and_then(|v| v.as_str()).unwrap_or("meeting");
            let ftitle = f.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let fcards: Vec<&Value> = shapes.iter().filter(|s| s.get("frameId").and_then(|v| v.as_str()) == Some(fid)).collect();
            md += &section(&format!("{}:{}", board_types::board_type(ftype).label, ftitle), ftype, &fcards, "##");
        }
    } else {
        let all: Vec<&Value> = shapes.iter().collect();
        md = section(&format!("{}:{}", board_types::board_type(&mtype).label, if topic.is_empty() { "board".to_string() } else { topic }), &mtype, &all, "#");
    }
    md
}

fn strip_think(s: &str) -> String {
    let mut out = s.to_string();
    while let (Some(a), Some(b)) = (out.find("<think>"), out.find("</think>")) {
        if b > a {
            out.replace_range(a..b + "</think>".len(), "");
        } else {
            break;
        }
    }
    out.trim().to_string()
}

// one-page meeting note via the LLM (port of /api/summary)
async fn summary_markdown(room: &sync::Room, name: &str, local_only: bool, llm: &llm::LlmOpts) -> String {
    let shapes: Vec<Value> = store::read_map(room, "shapes").into_iter().filter(|s| s.get("type").and_then(|v| v.as_str()) == Some("sticky")).collect();
    let conns = store::read_map(room, "connectors");
    if shapes.is_empty() {
        return format!("# 會議摘要:{}\n\n(白板還沒有內容)\n", name);
    }
    let kind = |c: &str| match c {
        "yellow" => "主題",
        "green" => "待辦",
        "blue" => "決議",
        "red" => "風險",
        _ => "其他",
    };
    let named = |s: &Value| -> String {
        match s.get("drawnBy").and_then(|v| v.as_str()) {
            Some(d) if !["user", "agent", "voice", "bot"].contains(&d) => format!("({})", d),
            _ => String::new(),
        }
    };
    let lines: Vec<String> = shapes
        .iter()
        .map(|s| format!("- [{}] {}{}", kind(s.get("color").and_then(|v| v.as_str()).unwrap_or("yellow")), s.get("text").and_then(|v| v.as_str()).unwrap_or(""), named(s)))
        .collect();
    let text = |id: &str| -> Option<String> { shapes.iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id)).and_then(|s| s.get("text").and_then(|v| v.as_str())).map(|x| x.to_string()) };
    let rel: Vec<String> = conns
        .iter()
        .filter_map(|c| {
            let f = text(c.get("from").and_then(|v| v.as_str())?)?;
            let t = text(c.get("to").and_then(|v| v.as_str())?)?;
            Some(format!("- {} → {}", f, t))
        })
        .collect();
    let board = format!("便利貼(括號內是提出者):\n{}\n\n關聯:\n{}", lines.join("\n"), if rel.is_empty() { "(無)".to_string() } else { rel.join("\n") });
    let sys = "你是會議記錄員。根據提供的白板便利貼(已分類)整理成一頁繁體中文會議紀錄,用這些區塊:## 會議重點 / ## 決議 / ## 待辦事項(若便利貼標了提出者,在待辦後標負責人)/ ## 風險 / ## 下一步。只根據提供內容,不得編造;沒有內容的區塊就省略。直接輸出 markdown,不要前言。";
    match llm::chat(&[llm::Msg { role: "system", content: sys.into() }, llm::Msg { role: "user", content: board }], false, local_only, llm).await {
        Ok((t, _)) => format!("# 會議摘要:{}\n\n{}\n", name, strip_think(&t)),
        Err(e) => format!("摘要失敗:{}", e),
    }
}

// per-room serialization lock (replaces the global lock)
static ROOM_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
async fn room_lock(name: &str) -> Arc<Mutex<()>> {
    ROOM_LOCKS.lock().await.entry(name.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// 把整段逐字稿切成適合餵 agent 的塊:先按換行 / 句末標點切小單位,再併到約 200 字一塊,
/// 壓低 LLM 呼叫數(agent 每次只處理「一段」、最多 6 張卡,整段硬塞會被截掉)。
fn chunk_transcript(t: &str) -> Vec<String> {
    const MAX: usize = 200;
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for unit in t
        .split(['\n', '。', '!', '?', '!', '?', ';', ';'])
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        if !cur.is_empty() && cur.chars().count() + unit.chars().count() > MAX {
            chunks.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push('。');
        }
        cur.push_str(unit);
    }
    if !cur.trim().is_empty() {
        chunks.push(cur);
    }
    chunks
}

pub async fn serve(port: u16) {
    let rooms = sync::new_rooms();
    sync::init_persistence(rooms.clone());

    // --- websocket sync (any path; strips optional sync/ prefix) ---
    let rooms_ws = rooms.clone();
    let ws = warp::path::tail().and(warp::ws()).and_then(move |tail: warp::path::Tail, ws: warp::ws::Ws| {
        let rooms = rooms_ws.clone();
        async move {
            let mut name = tail.as_str().to_string();
            if let Some(r) = name.strip_prefix("sync/") {
                name = r.to_string();
            }
            let name = percent_encoding::percent_decode_str(&name).decode_utf8_lossy().to_string();
            let room = sync::get_or_create_room(&rooms, &name).await;
            Ok::<_, warp::Rejection>(ws.on_upgrade(move |socket| sync::peer(socket, room)))
        }
    });

    let health = warp::get().and(warp::path!("api" / "health")).map(|| warp::reply::json(&json!({ "ok": true, "server": "rust" })));
    let lan = warp::get().and(warp::path!("api" / "lan")).map(|| warp::reply::json(&json!({ "ip": lan_ip() })));

    // GET /api/rooms — active rooms (shapes + online counts)
    let r_rooms = rooms.clone();
    let rooms_list = warp::get().and(warp::path!("api" / "rooms")).and(with(r_rooms)).and_then(|rooms: sync::Rooms| async move {
        let map = rooms.read().await;
        let mut out = vec![];
        for (id, room) in map.iter() {
            let shapes = store::read_map(room, "shapes").len();
            out.push(json!({ "id": id, "shapes": shapes, "online": 0 }));
        }
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "rooms": out })))
    });

    // POST /api/rooms/:room/tidy
    let r_tidy = rooms.clone();
    let tidy = warp::post().and(warp::path!("api" / "rooms" / String / "tidy")).and(with(r_tidy)).and_then(|name: String, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        let (mtype, _topic) = store::read_meta(&room);
        let sp = SETTINGS.lock().await.spacing;
        let shapes = store::read_map(&room, "shapes");
        let conns = store::read_map(&room, "connectors");
        let frames = store::read_map(&room, "frames");
        let (pos, fsz) = layout::tidy(&mtype, &shapes, &conns, &frames, sp);
        store::apply_tidy(&room, &pos, &fsz);
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true })))
    });

    // POST /api/rooms/:room/end
    let r_end = rooms.clone();
    let end = warp::post().and(warp::path!("api" / "rooms" / String / "end")).and(with(r_end)).and_then(|name: String, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        store::clear_room(&room);
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true })))
    });

    // GET/POST /api/rooms/:room/meta
    let r_meta_g = rooms.clone();
    let meta_get = warp::get().and(warp::path!("api" / "rooms" / String / "meta")).and(with(r_meta_g)).and_then(|name: String, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        let (typ, topic) = store::read_meta(&room);
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "type": typ, "topic": topic, "types": board_types::types_list() })))
    });
    let r_meta_p = rooms.clone();
    let meta_post = warp::post().and(warp::path!("api" / "rooms" / String / "meta")).and(warp::body::json()).and(with(r_meta_p)).and_then(|name: String, body: Value, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        let typ = body.get("type").and_then(|v| v.as_str());
        let typ = typ.filter(|t| board_types::BOARD_TYPES.iter().any(|b| b.key == *t));
        let topic = body.get("topic").and_then(|v| v.as_str());
        store::set_meta(&room, typ, topic);
        let (t, tp) = store::read_meta(&room);
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "type": t, "topic": tp })))
    });

    // GET/POST /api/rooms/:room/frames
    let r_frames_g = rooms.clone();
    let frames_get = warp::get().and(warp::path!("api" / "rooms" / String / "frames")).and(with(r_frames_g)).and_then(|name: String, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "frames": store::frames_sorted(&room) })))
    });
    let r_frames_p = rooms.clone();
    let frames_post = warp::post().and(warp::path!("api" / "rooms" / String / "frames")).and(warp::body::json()).and(with(r_frames_p)).and_then(|name: String, body: Value, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        let typ = body.get("type").and_then(|v| v.as_str()).filter(|t| board_types::BOARD_TYPES.iter().any(|b| b.key == *t)).unwrap_or(board_types::DEFAULT_BOARD_TYPE);
        let title = body.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let f = store::create_frame(&room, typ, title);
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "frame": f })))
    });

    // GET /api/export/:room
    let r_export = rooms.clone();
    let export = warp::get().and(warp::path!("api" / "export" / String)).and(with(r_export)).and_then(|name: String, rooms: sync::Rooms| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        let md = export_markdown(&room);
        Ok::<_, warp::Rejection>(warp::reply::with_header(md, "Content-Type", "text/markdown; charset=utf-8"))
    });

    // GET /api/summary/:room — one-page meeting note via the LLM
    let r_summary = rooms.clone();
    let summary = warp::get().and(warp::path!("api" / "summary" / String)).and(with(r_summary)).and(llm_opts()).and_then(|name: String, rooms: sync::Rooms, llm: llm::LlmOpts| async move {
        let room = sync::get_or_create_room(&rooms, &name).await;
        let lo = SETTINGS.lock().await.local_only;
        let md = summary_markdown(&room, &name, lo, &llm).await;
        Ok::<_, warp::Rejection>(warp::reply::with_header(md, "Content-Type", "text/markdown; charset=utf-8"))
    });

    // GET/POST /api/settings
    let settings_get = warp::get().and(warp::path!("api" / "settings")).and_then(|| async move {
        let s = SETTINGS.lock().await.clone();
        let mut o = json!({ "ok": true, "spacing": s.spacing, "autoTidy": s.auto_tidy, "mode": s.mode, "sttSource": s.stt_source, "localOnly": s.local_only, "whisperUrl": s.whisper_url, "groqKey": llm::groq_key().is_some() });
        for src in [llm::config_info(), stt::stt_capabilities(), sponsor_config()] {
            if let (Value::Object(dst), Value::Object(m)) = (&mut o, src) {
                for (k, v) in m {
                    dst.insert(k, v);
                }
            }
        }
        Ok::<_, warp::Rejection>(warp::reply::json(&o))
    });
    let settings_post = warp::post().and(warp::path!("api" / "settings")).and(warp::body::json()).and_then(|body: Value| async move {
        let mut s = SETTINGS.lock().await;
        if let Some(v) = body.get("spacing").and_then(|v| v.as_f64()) {
            s.spacing = v.clamp(0.6, 2.0);
        }
        if let Some(v) = body.get("autoTidy").and_then(|v| v.as_bool()) {
            s.auto_tidy = v;
        }
        if let Some(v) = body.get("mode").and_then(|v| v.as_str()) {
            if v == "mori" || v == "custom" {
                s.mode = v.into();
            }
        }
        if let Some(v) = body.get("sttSource").and_then(|v| v.as_str()) {
            if v == "cloud" || v == "local" {
                s.stt_source = v.into();
            }
        }
        if let Some(v) = body.get("localOnly").and_then(|v| v.as_bool()) {
            s.local_only = v;
        }
        if let Some(v) = body.get("whisperUrl").and_then(|v| v.as_str()) {
            s.whisper_url = v.chars().take(200).collect();
        }
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "spacing": s.spacing, "autoTidy": s.auto_tidy, "mode": s.mode, "sttSource": s.stt_source, "localOnly": s.local_only, "whisperUrl": s.whisper_url })))
    });

    // POST /api/agent/:room — the AI turn (intent classify -> command or content)
    let r_agent = rooms.clone();
    let agent_ep = warp::post().and(warp::path!("api" / "agent" / String)).and(warp::body::json()).and(with(r_agent)).and(warp::header::optional::<String>("x-forwarded-for")).and(llm_opts()).and_then(|name: String, body: Value, rooms: sync::Rooms, xff: Option<String>, llm: llm::LlmOpts| async move {
        if !rate_ok(&client_ip(&xff)).await {
            return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "太頻繁了,休息一下再試(demo 限流)" })));
        }
        let transcript = body.get("transcript").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if transcript.is_empty() {
            return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "transcript required" })));
        }
        let by: String = body.get("by").and_then(|v| v.as_str()).unwrap_or("agent").chars().take(24).collect();
        let room = sync::get_or_create_room(&rooms, &name).await;
        let s = SETTINGS.lock().await.clone();
        let _lk = room_lock(&name).await; let _guard = _lk.lock().await; // serialize agent turns (per-room race guard)
        let res = apply::run_agent_turn(&room, &transcript, &by, s.local_only, s.auto_tidy, s.spacing, &llm).await;
        Ok(match res {
            Ok(v) => warp::reply::json(&v),
            Err(e) => warp::reply::json(&json!({ "ok": false, "error": e })),
        })
    });

    // POST /api/transcribe — audio -> text (no agent)
    let transcribe_ep = warp::post().and(warp::path!("api" / "transcribe")).and(warp::query::<HashMap<String, String>>()).and(warp::body::bytes()).and(warp::header::optional::<String>("x-forwarded-for")).and_then(|q: HashMap<String, String>, body: bytes::Bytes, xff: Option<String>| async move {
        if !rate_ok(&client_ip(&xff)).await {
            return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "太頻繁了,休息一下(demo 限流)" })));
        }
        let ext = sanitize_ext(q.get("ext").map(|s| s.as_str()).unwrap_or("webm"));
        let tmp = write_tmp("t", &ext, &body).await;
        let s = SETTINGS.lock().await.clone();
        let r = stt::transcribe(&tmp, &s.mode, &s.stt_source, &s.whisper_url).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        Ok::<_, warp::Rejection>(match r {
            Ok(text) => warp::reply::json(&json!({ "ok": true, "text": text })),
            Err(e) => warp::reply::json(&json!({ "ok": false, "error": e })),
        })
    });

    // POST /api/voice/:room — audio -> STT -> agent turn
    let r_voice = rooms.clone();
    let voice_ep = warp::post().and(warp::path!("api" / "voice" / String)).and(warp::query::<HashMap<String, String>>()).and(warp::body::bytes()).and(with(r_voice)).and(warp::header::optional::<String>("x-forwarded-for")).and(llm_opts()).and_then(
        |name: String, q: HashMap<String, String>, body: bytes::Bytes, rooms: sync::Rooms, xff: Option<String>, llm: llm::LlmOpts| async move {
            if !rate_ok(&client_ip(&xff)).await {
                return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "太頻繁了,休息一下(demo 限流)" })));
            }
            let ext = sanitize_ext(q.get("ext").map(|s| s.as_str()).unwrap_or("webm"));
            let tmp = write_tmp("voice", &ext, &body).await;
            let s = SETTINGS.lock().await.clone();
            let transcript = stt::transcribe(&tmp, &s.mode, &s.stt_source, &s.whisper_url).await;
            let _ = tokio::fs::remove_file(&tmp).await;
            let transcript = match transcript {
                Ok(t) => t,
                Err(e) => return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": e }))),
            };
            if transcript.trim().is_empty() {
                return Ok(warp::reply::json(&json!({ "ok": true, "transcript": "", "stickies": 0 })));
            }
            let by: String = q.get("by").map(|s| s.as_str()).unwrap_or("voice").chars().take(24).collect();
            let room = sync::get_or_create_room(&rooms, &name).await;
            let _lk = room_lock(&name).await; let _guard = _lk.lock().await;
            let mut res = match apply::run_agent_turn(&room, &transcript, &by, s.local_only, s.auto_tidy, s.spacing, &llm).await {
                Ok(v) => v,
                Err(e) => json!({ "ok": false, "error": e }),
            };
            res["transcript"] = json!(transcript);
            Ok(warp::reply::json(&res))
        },
    );

    // POST /api/card/:room/:cardId — dictate one card's text/tags/owner/kind
    let r_card = rooms.clone();
    let card_ep = warp::post().and(warp::path!("api" / "card" / String / String)).and(warp::query::<HashMap<String, String>>()).and(warp::body::bytes()).and(with(r_card)).and(warp::header::optional::<String>("x-forwarded-for")).and(llm_opts()).and_then(
        |name: String, card_id: String, q: HashMap<String, String>, body: bytes::Bytes, rooms: sync::Rooms, xff: Option<String>, llm: llm::LlmOpts| async move {
            if !rate_ok(&client_ip(&xff)).await {
                return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "太頻繁了,休息一下(demo 限流)" })));
            }
            let ext = sanitize_ext(q.get("ext").map(|s| s.as_str()).unwrap_or("webm"));
            let tmp = write_tmp("c", &ext, &body).await;
            let s = SETTINGS.lock().await.clone();
            let transcript = stt::transcribe(&tmp, &s.mode, &s.stt_source, &s.whisper_url).await.unwrap_or_default();
            let _ = tokio::fs::remove_file(&tmp).await;
            let room = sync::get_or_create_room(&rooms, &name).await;
            let cur = apply::card_current(&room, &card_id);
            if cur.is_none() {
                return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "card not found", "transcript": transcript })));
            }
            if transcript.trim().is_empty() {
                return Ok(warp::reply::json(&json!({ "ok": true, "transcript": "", "edit": {} })));
            }
            let (text, owner, tags) = cur.unwrap();
            let _lk = room_lock(&name).await; let _guard = _lk.lock().await;
            let edit = match agent::plan_card_edit(&transcript, &text, owner.as_deref(), tags.as_deref(), s.local_only, &llm).await {
                Ok(e) => e,
                Err(e) => return Ok(warp::reply::json(&json!({ "ok": false, "error": e, "transcript": transcript }))),
            };
            apply::apply_card_edit(&room, &card_id, &edit);
            let mut ej = serde_json::Map::new();
            if let Some(t) = &edit.text {
                ej.insert("text".into(), json!(t));
            }
            if let Some(t) = &edit.tags {
                ej.insert("tags".into(), json!(t));
            }
            if let Some(o) = &edit.owner {
                ej.insert("owner".into(), json!(o));
            }
            if let Some(c) = &edit.color {
                ej.insert("color".into(), json!(c));
            }
            Ok(warp::reply::json(&json!({ "ok": true, "transcript": transcript, "edit": ej })))
        },
    );

    // POST /api/visualize — headless「整段逐字稿 → 建板 → 匯出」。AgentOS dispatch meeting.visualize 走這支:
    // 切塊逐塊餵 agent 建板 → tidy → 回 markdown / summary + 一個能打開**繼續編輯**的 url(room 持久化;
    // html/png 匯出走 client)。body: { transcript(必), room?, board_type? }。
    let r_viz = rooms.clone();
    let visualize_ep = warp::post()
        .and(warp::path!("api" / "visualize"))
        .and(warp::body::json())
        .and(with(r_viz))
        .and(warp::header::optional::<String>("x-forwarded-for"))
        .and(llm_opts())
        .and_then(move |body: Value, rooms: sync::Rooms, xff: Option<String>, llm: llm::LlmOpts| async move {
            if !rate_ok(&client_ip(&xff)).await {
                return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "太頻繁了,休息一下再試" })));
            }
            let transcript = body.get("transcript").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if transcript.is_empty() {
                return Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": false, "error": "transcript required" })));
            }
            let name = body
                .get("room")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("visualize-{}", store::rid()));
            let room = sync::get_or_create_room(&rooms, &name).await;
            if let Some(bt) = body.get("board_type").and_then(|v| v.as_str()) {
                store::set_meta(&room, Some(bt), None);
            }
            let s = SETTINGS.lock().await.clone();
            let _lk = room_lock(&name).await;
            let _guard = _lk.lock().await; // serialize per-room
            let chunks = chunk_transcript(&transcript);
            let total = chunks.len();
            let mut turns = 0usize;
            for c in &chunks {
                // auto_tidy=false:逐塊建板別每塊都重排,最後統一 tidy 一次。
                if apply::run_agent_turn(&room, c, "AI", s.local_only, false, s.spacing, &llm).await.is_ok() {
                    turns += 1;
                }
            }
            apply::tidy_board(&room, s.spacing);
            let markdown = export_markdown(&room);
            let summary = summary_markdown(&room, &name, s.local_only, &llm).await;
            let cards = store::read_map(&room, "shapes").iter().filter(|x| x.get("type").and_then(|v| v.as_str()) == Some("sticky")).count();
            let frames = store::frames_sorted(&room).len();
            Ok(warp::reply::json(&json!({
                "ok": true,
                "room": name,
                "url": format!("http://127.0.0.1:{}/?room={}", port, name),
                "chunks": total,
                "turns": turns,
                "cards": cards,
                "frames": frames,
                "markdown": markdown,
                "summary": summary
            })))
        });

    let api = agent_ep
        .or(visualize_ep)
        .or(transcribe_ep)
        .or(voice_ep)
        .or(card_ep)
        .or(health)
        .or(lan)
        .or(rooms_list)
        .or(tidy)
        .or(end)
        .or(meta_get)
        .or(meta_post)
        .or(frames_get)
        .or(frames_post)
        .or(export)
        .or(summary)
        .or(settings_get)
        .or(settings_post);

    let cors = warp::cors().allow_any_origin().allow_methods(vec!["GET", "POST", "OPTIONS"]).allow_headers(vec!["Content-Type", "x-llm-base", "x-llm-key", "x-llm-model"]);
    // serve the embedded client (single self-contained binary: client + sync + api on one port).
    // SPA fallback: unknown paths -> index.html.
    let serve_client = warp::get().and(warp::path::full()).map(|p: warp::path::FullPath| {
        let raw = p.as_str().trim_start_matches('/');
        let (file, mime) = match (!raw.is_empty()).then(|| CLIENT_ASSETS.get_file(raw)).flatten() {
            Some(f) => (Some(f), mime_for(raw)),
            None => (CLIENT_ASSETS.get_file("index.html"), "text/html; charset=utf-8"),
        };
        match file {
            Some(f) => warp::http::Response::builder().header("Content-Type", mime).body(f.contents().to_vec()).unwrap(),
            None => warp::http::Response::builder().status(404).body(b"not found".to_vec()).unwrap(),
        }
    });
    let routes = api.or(ws).or(serve_client).with(cors);
    maybe_register_body_part(port);
    let _ = Arc::clone(&rooms);

    // BIND (default 0.0.0.0 so LAN devices reach it; Tauri sets 127.0.0.1).
    // HTTPS=1 + certs => serve TLS itself (replaces Vite's HTTPS role; LAN mic needs a secure ctx).
    let ip: std::net::Ipv4Addr = std::env::var("BIND").ok().and_then(|b| b.parse().ok()).unwrap_or(std::net::Ipv4Addr::new(0, 0, 0, 0));
    let cert = std::env::var("TLS_CERT").unwrap_or_else(|_| "certs/cert.pem".into());
    let key = std::env::var("TLS_KEY").unwrap_or_else(|_| "certs/key.pem".into());
    let server = warp::serve(routes);
    if std::env::var("HTTPS").as_deref() == Ok("1") && std::path::Path::new(&cert).exists() && std::path::Path::new(&key).exists() {
        println!("mori-canvas-server (Rust, HTTPS) on https://{ip}:{port}");
        server.tls().cert_path(&cert).key_path(&key).run((ip, port)).await;
    } else {
        println!("mori-canvas-server (Rust) on http://{ip}:{port}");
        server.run((ip, port)).await;
    }
}
