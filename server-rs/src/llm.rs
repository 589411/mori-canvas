//! Port of llm.ts — Groq (gpt-oss-120b) -> Ollama (qwen3) cascade via reqwest.
//! Key + models from the shared ~/.mori/config.json.
use serde_json::{json, Value};

pub struct Msg {
    pub role: &'static str,
    pub content: String,
}

fn mori_config() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    std::fs::read_to_string(format!("{}/.mori/config.json", home)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}

fn is_placeholder(k: &str) -> bool {
    k.starts_with("REPLACE") || k.contains("YOUR_GROQ") || k == "TODO"
}

pub fn groq_key() -> Option<String> {
    if let Ok(env) = std::env::var("GROQ_API_KEY") {
        if !env.is_empty() && !is_placeholder(&env) {
            return Some(env);
        }
    }
    let c = mori_config();
    c.get("providers").and_then(|p| p.get("groq")).and_then(|g| g.get("api_key")).and_then(|k| k.as_str()).filter(|k| !is_placeholder(k)).map(|s| s.to_string())
}

pub fn config_info() -> Value {
    let c = mori_config();
    let g = |path: &[&str], d: &str| -> String {
        let mut cur = &c;
        for p in path {
            match cur.get(p) {
                Some(v) => cur = v,
                None => return d.to_string(),
            }
        }
        cur.as_str().unwrap_or(d).to_string()
    };
    json!({
        "llmGroqModel": g(&["providers","groq","model"], "openai/gpt-oss-120b"),
        "llmOllamaModel": g(&["providers","ollama","model"], "qwen3:8b"),
        "sttProvider": g(&["stt_provider"], "groq"),
        "sttGroqModel": g(&["providers","groq","stt_model"], "whisper-large-v3-turbo"),
        "sttLocalModel": g(&["providers","whisper-local","model_path"], "(未設定)"),
    })
}

async fn call_groq(messages: &[Msg], json_mode: bool) -> Result<String, String> {
    let key = groq_key().ok_or("no groq api key")?;
    let c = mori_config();
    let model = c.get("providers").and_then(|p| p.get("groq")).and_then(|g| g.get("model")).and_then(|m| m.as_str()).unwrap_or("openai/gpt-oss-120b").to_string();
    let msgs: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
    let mut body = json!({ "model": model, "messages": msgs });
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let res = reqwest::Client::new()
        .post("https://api.groq.com/openai/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("groq req: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("groq {}: {}", res.status(), res.text().await.unwrap_or_default().chars().take(200).collect::<String>()));
    }
    let data: Value = res.json().await.map_err(|e| format!("groq json: {e}"))?;
    data.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|c| c.as_str()).map(|s| s.to_string()).ok_or_else(|| "groq: no content".into())
}

async fn call_ollama(messages: &[Msg], json_mode: bool) -> Result<String, String> {
    let c = mori_config();
    let base = c.get("providers").and_then(|p| p.get("ollama")).and_then(|o| o.get("base_url")).and_then(|b| b.as_str()).unwrap_or("http://localhost:11434").trim_end_matches('/').to_string();
    let model = c.get("providers").and_then(|p| p.get("ollama")).and_then(|o| o.get("model")).and_then(|m| m.as_str()).unwrap_or("qwen3:8b").to_string();
    let msgs: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
    let mut body = json!({ "model": model, "messages": msgs, "stream": false, "think": false, "options": { "num_ctx": 8192 } });
    if json_mode {
        body["format"] = json!("json");
    }
    let res = reqwest::Client::new().post(format!("{}/api/chat", base)).json(&body).send().await.map_err(|e| format!("ollama unreachable at {base}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("ollama {}", res.status()));
    }
    let data: Value = res.json().await.map_err(|e| format!("ollama json: {e}"))?;
    data.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()).map(|s| s.to_string()).ok_or_else(|| "ollama: no content".into())
}

/// Groq first; on failure fall back to Ollama. local_only => Ollama only.
pub async fn chat(messages: &[Msg], json_mode: bool, local_only: bool) -> Result<(String, String), String> {
    if local_only {
        return Ok((call_ollama(messages, json_mode).await?, "ollama(local-only)".into()));
    }
    match call_groq(messages, json_mode).await {
        Ok(t) => Ok((t, "groq:gpt-oss-120b".into())),
        Err(ge) => match call_ollama(messages, json_mode).await {
            Ok(t) => Ok((t, "ollama".into())),
            Err(oe) => Err(format!("both LLM providers failed — groq: {ge}; ollama: {oe}")),
        },
    }
}
