#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Mori Canvas desktop (Tauri 2). Embeds the mori-canvas-server (one binary), runs it
//! on a loopback port, and loads that URL in the webview so the client's same-origin
//! /api + /sync reach the embedded server. Self-registers as a mori-desktop body part.
use std::net::TcpStream;
use std::time::Duration;

const PORT: u16 = 8731;

// mori-desktop BodyManifest self-register (kind: standalone_app, entrypoint = this binary),
// mirroring mori-meeting-recorder/src-tauri/src/manifest.rs.
fn register_body_part() {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.mori/body-parts/mori.canvas", home);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let manifest = serde_json::json!({
        "schema_version": 1,
        "id": "mori.canvas",
        "name": "Mori Canvas",
        "kind": "standalone_app",
        "description": "會議共筆白板 — AI 把語音/逐字稿整理成便利貼+圖,多人即時協作。",
        "capabilities": ["whiteboard.collaborate", "meeting.visualize", "transcribe.local"],
        "entrypoints": { "app": exe },
        "interfaces": [
            { "name": "api", "transport": "http", "base_url": format!("http://127.0.0.1:{}", PORT) }
        ],
        "permissions": [],
        "data_policy": { "owns_raw_data": true, "default_ingestion": "off" }
    });
    let _ = std::fs::write(format!("{}/manifest.json", dir), serde_json::to_string_pretty(&manifest).unwrap());
}

fn main() {
    // the embedded server is for this desktop app only — keep it on loopback
    std::env::set_var("BIND", "127.0.0.1");
    // start the embedded mori-canvas server on a background multi-thread runtime
    std::thread::spawn(|| {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
        rt.block_on(mori_canvas_server::serve(PORT));
    });
    // wait until it's listening (so the webview doesn't load before the server binds)
    for _ in 0..80 {
        if TcpStream::connect(("127.0.0.1", PORT)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    register_body_part();
    // AgentOS 服務發現:寫 ~/.mori/mori-canvas-server.json,讓 agentos dispatch meeting.visualize → /api/visualize。
    mori_canvas_server::write_agentos_descriptor(PORT);

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running mori-canvas");
}
