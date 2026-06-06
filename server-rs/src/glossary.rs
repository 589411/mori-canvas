//! 會議參考文件 → 詞彙表(glossary)。
//! 上傳的開會文件(前端抽好純文字)由 LLM 萃取專有名詞,三個用途:
//! (1) Whisper STT 的 initial prompt 偏置(降低專名聽錯率)
//! (2) agent prompt 注入,讓 LLM 把逐字稿裡聽錯的專名校正回正確寫法
//! (3) 之後匯出可附詞彙表
//! 注意:Whisper 的 prompt 只吃約 224 tokens,所以 whisper_prompt() 嚴格截斷,
//! 重要的詞(萃取時排前面的)優先進去;完整詞彙表只有 agent 看得到。
use crate::llm::{chat, LlmOpts, Msg};
use serde_json::{json, Value};

const MAX_TERMS: usize = 60; // 多份文件合併後的上限
const MAX_DOC_CHARS: usize = 20_000;
const WHISPER_PROMPT_MAX_CHARS: usize = 200; // 中文 1 字 ≈ 1+ token,保守留 224 token 內

fn s_field(v: &Value, key: &str, max: usize) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.trim().chars().take(max).collect::<String>()).filter(|s| !s.is_empty())
}

/// sanitize one raw term object from the LLM
fn sanitize_term(v: &Value) -> Option<Value> {
    let term = s_field(v, "term", 24)?;
    let mut o = json!({ "term": term });
    if let Some(arr) = v.get("aliases").and_then(|x| x.as_array()) {
        let aliases: Vec<String> = arr.iter().filter_map(|a| a.as_str()).map(|a| a.trim().chars().take(24).collect::<String>()).filter(|a| !a.is_empty()).take(4).collect();
        if !aliases.is_empty() {
            o["aliases"] = json!(aliases);
        }
    }
    if let Some(n) = s_field(v, "note", 30) {
        o["note"] = json!(n);
    }
    Some(o)
}

/// merge new terms into existing(以 term 去重,先到先贏),cap MAX_TERMS
pub fn merge_terms(existing: &[Value], new_terms: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = existing.to_vec();
    for t in new_terms {
        let term = t.get("term").and_then(|x| x.as_str()).unwrap_or("");
        if out.len() >= MAX_TERMS {
            break;
        }
        if !term.is_empty() && !out.iter().any(|e| e.get("term").and_then(|x| x.as_str()) == Some(term)) {
            out.push(t);
        }
    }
    out
}

/// LLM 萃取:文件純文字 → terms(已 sanitize,重要的在前)
pub async fn extract(doc_text: &str, local_only: bool, llm: &LlmOpts) -> Result<Vec<Value>, String> {
    let text: String = doc_text.chars().take(MAX_DOC_CHARS).collect();
    let user = format!("會議參考文件(三引號內):\n\"\"\"\n{}\n\"\"\"", text);
    let messages = vec![Msg { role: "system", content: crate::prompts::prompt("glossary") }, Msg { role: "user", content: user }];
    let (out, _provider) = chat(&messages, true, local_only, llm).await?;
    let obj = crate::agent::extract_json(&out).ok_or("詞彙表萃取:模型沒有回 JSON")?;
    let terms = obj.get("terms").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    Ok(terms.iter().filter_map(sanitize_term).take(MAX_TERMS).collect())
}

/// Whisper initial prompt:詞彙逗號相連、嚴格截斷(重要的在前所以截尾巴)。空表 → 空字串。
pub fn whisper_prompt(terms: &[Value]) -> String {
    let mut out = String::new();
    for t in terms {
        let Some(term) = t.get("term").and_then(|x| x.as_str()) else { continue };
        let cand = if out.is_empty() { format!("會議詞彙:{}", term) } else { format!("{}、{}", out, term) };
        if cand.chars().count() > WHISPER_PROMPT_MAX_CHARS {
            break;
        }
        out = cand;
    }
    if !out.is_empty() {
        out.push('。');
    }
    out
}

/// agent user-message 區塊:完整詞彙表 + 校正指示。空表 → 空字串。
pub fn agent_block(terms: &[Value]) -> String {
    if terms.is_empty() {
        return String::new();
    }
    let lst: Vec<String> = terms
        .iter()
        .filter_map(|t| {
            let term = t.get("term").and_then(|x| x.as_str())?;
            let mut line = format!("  - {}", term);
            if let Some(a) = t.get("aliases").and_then(|x| x.as_array()) {
                let al: Vec<&str> = a.iter().filter_map(|x| x.as_str()).collect();
                if !al.is_empty() {
                    line.push_str(&format!("(聽錯時常寫成:{})", al.join("、")));
                }
            }
            if let Some(n) = t.get("note").and_then(|x| x.as_str()) {
                line.push_str(&format!(" — {}", n));
            }
            Some(line)
        })
        .collect();
    format!(
        "\n\n【本會議詞彙表】(從上傳的會議文件萃取。「使用者這段話」是語音辨識結果,若其中出現與下列詞彙發音相近但寫法不同的字,視為辨識錯誤,你輸出的卡片文字一律改用詞彙表的正確寫法;人名、產品名以此表為準):\n{}",
        lst.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(term: &str) -> Value {
        json!({ "term": term })
    }

    #[test]
    fn whisper_prompt_truncates_and_keeps_head() {
        let terms: Vec<Value> = (0..100).map(|i| t(&format!("詞彙編號{:02}", i))).collect();
        let p = whisper_prompt(&terms);
        assert!(p.chars().count() <= WHISPER_PROMPT_MAX_CHARS + 1, "len={}", p.chars().count());
        assert!(p.starts_with("會議詞彙:詞彙編號00"), "head kept: {p}");
        assert!(p.ends_with('。'));
    }

    #[test]
    fn whisper_prompt_empty_for_no_terms() {
        assert_eq!(whisper_prompt(&[]), "");
    }

    #[test]
    fn merge_dedupes_by_term() {
        let a = vec![t("mori-canvas")];
        let merged = merge_terms(&a, vec![t("mori-canvas"), t("ZeroType")]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn sanitize_drops_empty_and_caps() {
        assert!(sanitize_term(&json!({ "term": "  " })).is_none());
        let v = sanitize_term(&json!({ "term": "A", "aliases": ["x","","y","z","w","v"], "note": "n" })).unwrap();
        assert_eq!(v["aliases"].as_array().unwrap().len(), 4); // capped
    }

    #[test]
    fn agent_block_mentions_aliases() {
        let terms = vec![json!({ "term": "mori-canvas", "aliases": ["魔力坎瓦斯"] })];
        let b = agent_block(&terms);
        assert!(b.contains("mori-canvas") && b.contains("魔力坎瓦斯"));
        assert_eq!(agent_block(&[]), "");
    }
}
