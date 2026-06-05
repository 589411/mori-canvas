//! Port of stt.ts — STT with 'mori' (delegate to mori-ear) and 'custom' modes
//! (cloud Groq Whisper / local whisper-server), with ffmpeg silence-trim in custom.
use crate::llm::groq_key;
use serde_json::Value;
use std::path::Path;

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}
fn ear_path() -> String {
    std::env::var("MORI_EAR_BIN").unwrap_or_else(|_| format!("{}/.cargo/bin/mori-ear", home()))
}
fn mori_config() -> Value {
    std::fs::read_to_string(format!("{}/.mori/config.json", home())).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(serde_json::json!({}))
}
fn whisper_server() -> Option<(String, u16, String)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/.mori/whisper-server.json", home())).ok()?).ok()?;
    Some((
        v.get("host").and_then(|x| x.as_str()).unwrap_or("127.0.0.1").to_string(),
        v.get("port").and_then(|x| x.as_u64()).unwrap_or(36969) as u16,
        v.get("inference_path").and_then(|x| x.as_str()).unwrap_or("/inference").to_string(),
    ))
}

pub fn stt_capabilities() -> Value {
    let ear = Path::new(&ear_path()).exists() || std::env::var("MORI_EAR_BIN").is_ok();
    serde_json::json!({ "moriEar": ear, "whisperServer": whisper_server().is_some(), "groqKey": groq_key().is_some() })
}

async fn trim_silence(in_path: &str) -> String {
    let out = format!("{}.trim.wav", in_path);
    let f = "silenceremove=start_periods=1:start_silence=0.15:start_threshold=-40dB:detection=peak";
    let af = format!("{f},areverse,{f},areverse");
    let ok = tokio::process::Command::new("ffmpeg")
        .args(["-y", "-i", in_path, "-af", &af, "-ar", "16000", "-ac", "1", &out])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok && Path::new(&out).exists() {
        out
    } else {
        in_path.to_string()
    }
}
async fn duration_sec(path: &str) -> f64 {
    tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
        .output()
        .await
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0) // unprobeable/empty (e.g. trimmed-away silence) => skip
}

async fn groq_whisper(path: &str) -> Result<String, String> {
    let key = groq_key().ok_or("雲端 STT 需要 Groq API key")?;
    let model = mori_config().get("providers").and_then(|p| p.get("groq")).and_then(|g| g.get("stt_model")).and_then(|m| m.as_str()).unwrap_or("whisper-large-v3-turbo").to_string();
    let buf = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(buf).file_name("audio.wav"))
        .text("model", model)
        .text("response_format", "json")
        .text("language", "zh");
    let res = reqwest::Client::new().post("https://api.groq.com/openai/v1/audio/transcriptions").header("Authorization", format!("Bearer {}", key)).multipart(form).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("groq whisper {}", res.status()));
    }
    let d: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(d.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string())
}

async fn local_whisper(path: &str, url_override: &str) -> Result<String, String> {
    let url = if !url_override.trim().is_empty() {
        url_override.trim().to_string()
    } else {
        let (h, p, ip) = whisper_server().unwrap_or(("127.0.0.1".into(), 36969, "/inference".into()));
        format!("http://{}:{}{}", h, p, ip)
    };
    let buf = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", reqwest::multipart::Part::bytes(buf).file_name("audio.wav")).text("response_format", "json");
    let res = reqwest::Client::new().post(&url).multipart(form).send().await.map_err(|e| format!("本機 whisper-server 連不到 {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("whisper-server {}", res.status()));
    }
    let d: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(d.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string())
}

/// mode: "mori" | "custom"; stt_source: "cloud" | "local"
pub async fn transcribe(audio_path: &str, mode: &str, stt_source: &str, whisper_url: &str) -> Result<String, String> {
    if mode != "custom" {
        let out = tokio::process::Command::new(ear_path()).args(["--input", audio_path]).output().await.map_err(|e| format!("mori-ear: {e}"))?;
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    // custom: silence-trim check first
    let trimmed = trim_silence(audio_path).await;
    let result = if duration_sec(&trimmed).await < 0.35 {
        Ok(String::new()) // basically silence → skip
    } else if stt_source == "local" {
        local_whisper(&trimmed, whisper_url).await
    } else {
        groq_whisper(&trimmed).await
    };
    if trimmed != audio_path {
        let _ = tokio::fs::remove_file(&trimmed).await;
    }
    result
}
