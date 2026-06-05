mod board_types;
mod layout;
mod store;
mod sync;
mod yval;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::Filter;

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
    Mutex::new(Settings {
        spacing: 1.0,
        auto_tidy: true,
        mode: "mori".into(),
        stt_source: "local".into(),
        local_only: false,
        whisper_url: String::new(),
    })
});

fn lan_ip() -> Option<String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

fn with<T: Clone + Send>(t: T) -> impl Filter<Extract = (T,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || t.clone())
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

#[tokio::main]
async fn main() {
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

    // GET/POST /api/settings
    let settings_get = warp::get().and(warp::path!("api" / "settings")).and_then(|| async move {
        let s = SETTINGS.lock().await.clone();
        Ok::<_, warp::Rejection>(warp::reply::json(&json!({ "ok": true, "spacing": s.spacing, "autoTidy": s.auto_tidy, "mode": s.mode, "sttSource": s.stt_source, "localOnly": s.local_only, "whisperUrl": s.whisper_url })))
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

    let api = health
        .or(lan)
        .or(rooms_list)
        .or(tidy)
        .or(end)
        .or(meta_get)
        .or(meta_post)
        .or(frames_get)
        .or(frames_post)
        .or(export)
        .or(settings_get)
        .or(settings_post);

    let cors = warp::cors().allow_any_origin().allow_methods(vec!["GET", "POST", "OPTIONS"]).allow_headers(vec!["Content-Type"]);
    let routes = api.or(ws).with(cors);

    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(1334);
    println!("mori-canvas-server (Rust) on http://127.0.0.1:{port}");
    let _ = Arc::clone(&rooms);
    warp::serve(routes).run(([127, 0, 0, 1], port)).await;
}
