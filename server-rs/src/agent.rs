//! Port of agent.ts — meeting transcript -> board plan OR a voice command, with
//! intent classification, frames, lenient JSON parsing. Uses the Groq->Ollama cascade.
use crate::board_types::{board_type, types_brief};
use crate::llm::{chat, LlmOpts, Msg};
use serde_json::Value;

pub fn color_by_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "topic" => Some("yellow"),
        "todo" => Some("green"),
        "decision" => Some("blue"),
        "risk" => Some("red"),
        _ => None,
    }
}
fn kind_zh(color: &str) -> &'static str {
    match color {
        "yellow" => "主題",
        "green" => "待辦",
        "blue" => "決議",
        "red" => "風險",
        _ => color_static(color),
    }
}
fn color_static(c: &str) -> &'static str {
    match c {
        "yellow" => "yellow",
        "green" => "green",
        "blue" => "blue",
        "red" => "red",
        _ => "其他",
    }
}

#[derive(Clone)]
pub struct StickyPlan {
    pub text: String,
    pub color: String,
    pub owner: Option<String>,
    pub tags: Option<Vec<String>>,
}
#[derive(Clone)]
pub struct StickyUpdate {
    pub index: usize,
    pub text: Option<String>,
    pub color: Option<String>,
}
#[derive(Clone)]
pub enum FrameTarget {
    Index(usize),
    New { typ: String, title: String },
}
#[derive(Clone)]
pub struct BoardPlan {
    pub stickies: Vec<StickyPlan>,
    pub connectors: Vec<(i64, i64)>,
    pub updates: Vec<StickyUpdate>,
    pub deletes: Vec<usize>,
    pub frame: Option<FrameTarget>,
}
#[derive(Clone)]
pub enum AgentCommand {
    Tidy,
    Filter { by: String, value: String },
    ClearFilter,
    Assign { index: usize, owner: String },
    Recolor { index: usize, kind: String },
    Tag { index: usize, tags: Vec<String> },
    Edit { index: usize, text: String },
    Move { index: usize, frame: usize },
    Zones { titles: Vec<String> },
    Connect { from: usize, to: usize },
}
pub enum AgentResult {
    Content(BoardPlan),
    Command(AgentCommand),
}

#[derive(Clone)]
pub struct ExistingCard {
    pub id: String,
    pub text: String,
    pub color: String,
    pub owner: Option<String>,
    pub tags: Option<Vec<String>>,
    pub frame_id: Option<String>,
}
#[derive(Clone)]
pub struct FrameInfo {
    pub id: String,
    pub title: String,
    pub typ: String,
}
#[derive(Default)]
pub struct CardEdit {
    pub text: Option<String>,
    pub tags: Option<Vec<String>>,
    pub owner: Option<String>,
    pub color: Option<String>,
}


pub(crate) fn extract_json(raw: &str) -> Option<Value> {
    let mut s = raw.to_string();
    // strip <think>...</think>
    while let (Some(a), Some(b)) = (s.find("<think>"), s.find("</think>")) {
        if b > a {
            s.replace_range(a..b + "</think>".len(), "");
        } else {
            break;
        }
    }
    let s = s.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim().to_string();
    let a = s.find('{')?;
    let b = s.rfind('}')?;
    if b > a {
        serde_json::from_str(&s[a..=b]).ok()
    } else {
        None
    }
}

fn to_idx(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
}

fn parse_content_plan(obj: &Value, existing_count: usize) -> BoardPlan {
    let mut stickies = vec![];
    if let Some(arr) = obj.get("stickies").and_then(|v| v.as_array()) {
        for x in arr.iter().take(8) {
            let text: String = x.get("text").and_then(|v| v.as_str()).unwrap_or("").chars().take(40).collect();
            if text.is_empty() {
                continue;
            }
            let kind = x.get("kind").and_then(|v| v.as_str());
            let color = kind.and_then(color_by_kind).map(|s| s.to_string()).or_else(|| x.get("color").and_then(|v| v.as_str()).map(|s| s.to_string())).unwrap_or_else(|| "yellow".into());
            let owner = x.get("owner").and_then(|v| v.as_str()).map(|s| s.trim().chars().take(10).collect::<String>()).filter(|s| !s.is_empty());
            let tags = x.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|t| t.as_str()).filter(|t| !t.trim().is_empty()).take(3).map(|t| t.trim().chars().take(8).collect::<String>()).collect::<Vec<_>>()).filter(|v: &Vec<String>| !v.is_empty());
            stickies.push(StickyPlan { text, color, owner, tags });
        }
    }
    let total = (existing_count + stickies.len()) as i64;
    let mut connectors = vec![];
    if let Some(arr) = obj.get("connectors").and_then(|v| v.as_array()) {
        for c in arr {
            let (a, b) = if let Some(arr2) = c.as_array() {
                (arr2.get(0).and_then(to_idx), arr2.get(1).and_then(to_idx))
            } else {
                (c.get("from").and_then(to_idx), c.get("to").and_then(to_idx))
            };
            if let (Some(a), Some(b)) = (a, b) {
                if a >= 0 && b >= 0 && a < total && b < total && a != b {
                    connectors.push((a, b));
                }
            }
        }
    }
    let mut updates = vec![];
    if let Some(arr) = obj.get("updates").and_then(|v| v.as_array()) {
        for u in arr {
            if let Some(i) = u.get("index").and_then(to_idx) {
                if i >= 0 && (i as usize) < existing_count {
                    let text = u.get("text").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()).map(|s| s.chars().take(40).collect());
                    let color = u.get("kind").and_then(|v| v.as_str()).and_then(color_by_kind).map(|s| s.to_string()).or_else(|| u.get("color").and_then(|v| v.as_str()).map(|s| s.to_string()));
                    if text.is_some() || color.is_some() {
                        updates.push(StickyUpdate { index: i as usize, text, color });
                    }
                }
            }
        }
    }
    let mut deletes = vec![];
    if let Some(arr) = obj.get("deletes").and_then(|v| v.as_array()) {
        for d in arr {
            if let Some(i) = to_idx(d) {
                if i >= 0 && (i as usize) < existing_count {
                    deletes.push(i as usize);
                }
            }
        }
    }
    let frame = match obj.get("frame") {
        Some(Value::Number(n)) => n.as_i64().filter(|i| *i >= 0).map(|i| FrameTarget::Index(i as usize)),
        Some(o) if o.is_object() => {
            if let Some(new) = o.get("new").filter(|n| n.is_object()) {
                new.get("type").and_then(|v| v.as_str()).map(|t| FrameTarget::New {
                    typ: t.to_string(),
                    title: new.get("title").and_then(|v| v.as_str()).unwrap_or("").chars().take(24).collect(),
                })
            } else {
                o.get("index").and_then(to_idx).filter(|i| *i >= 0).map(|i| FrameTarget::Index(i as usize))
            }
        }
        _ => None,
    };
    BoardPlan { stickies, connectors, updates, deletes, frame }
}

fn sanitize_command(c: &Value, existing_count: usize) -> Option<AgentCommand> {
    let in_range = |i: i64| i >= 0 && (i as usize) < existing_count;
    match c.get("action").and_then(|v| v.as_str())? {
        "tidy" => Some(AgentCommand::Tidy),
        "clearFilter" => Some(AgentCommand::ClearFilter),
        "filter" => {
            let by = if c.get("by").and_then(|v| v.as_str()) == Some("tag") { "tag" } else { "owner" };
            let value: String = c.get("value").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(16).collect();
            if value.is_empty() {
                None
            } else {
                Some(AgentCommand::Filter { by: by.into(), value })
            }
        }
        "assign" => {
            let i = c.get("index").and_then(to_idx)?;
            let owner: String = c.get("owner").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(10).collect();
            if in_range(i) && !owner.is_empty() {
                Some(AgentCommand::Assign { index: i as usize, owner })
            } else {
                None
            }
        }
        "recolor" => {
            let i = c.get("index").and_then(to_idx)?;
            let kind = c.get("kind").and_then(|v| v.as_str()).filter(|k| color_by_kind(k).is_some())?;
            if in_range(i) {
                Some(AgentCommand::Recolor { index: i as usize, kind: kind.into() })
            } else {
                None
            }
        }
        "tag" => {
            let i = c.get("index").and_then(to_idx)?;
            let tags: Vec<String> = c.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|t| t.as_str()).filter(|t| !t.trim().is_empty()).take(3).map(|t| t.trim().chars().take(8).collect()).collect()).unwrap_or_default();
            if in_range(i) && !tags.is_empty() {
                Some(AgentCommand::Tag { index: i as usize, tags })
            } else {
                None
            }
        }
        "edit" => {
            let i = c.get("index").and_then(to_idx)?;
            let text: String = c.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().chars().take(40).collect();
            if in_range(i) && !text.is_empty() {
                Some(AgentCommand::Edit { index: i as usize, text })
            } else {
                None
            }
        }
        "move" => {
            let i = c.get("index").and_then(to_idx)?;
            let frame = c.get("frame").and_then(to_idx)?;
            if in_range(i) && frame >= 0 {
                Some(AgentCommand::Move { index: i as usize, frame: frame as usize })
            } else {
                None
            }
        }
        "zones" => {
            let titles: Vec<String> = c
                .get("titles")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str()).map(|t| t.trim()).filter(|t| !t.is_empty()).take(8).map(|t| t.chars().take(20).collect()).collect())
                .unwrap_or_default();
            if titles.is_empty() {
                None
            } else {
                Some(AgentCommand::Zones { titles })
            }
        }
        "connect" => {
            let from = c.get("from").and_then(to_idx)?;
            let to = c.get("to").and_then(to_idx)?;
            if in_range(from) && in_range(to) && from != to {
                Some(AgentCommand::Connect { from: from as usize, to: to as usize })
            } else {
                None
            }
        }
        _ => None,
    }
}

fn parse_result(raw: &str, existing_count: usize) -> AgentResult {
    let obj = match extract_json(raw) {
        Some(o) => o,
        None => return AgentResult::Content(BoardPlan { stickies: vec![], connectors: vec![], updates: vec![], deletes: vec![], frame: None }),
    };
    if obj.get("intent").and_then(|v| v.as_str()) == Some("command") {
        if let Some(cmd) = obj.get("command").and_then(|c| sanitize_command(c, existing_count)) {
            return AgentResult::Command(cmd);
        }
    }
    AgentResult::Content(parse_content_plan(&obj, existing_count))
}

pub async fn plan_agent(transcript: &str, existing: &[ExistingCard], topic: &str, frames: &[FrameInfo], context: &[String], glossary_block: &str, local_only: bool, llm: &LlmOpts) -> Result<(AgentResult, String), String> {
    let topic_block = if topic.is_empty() { String::new() } else { format!("\n會議主題:「{}」", topic) };
    let frames_block = if frames.is_empty() {
        "\n\n目前畫布上沒有任何圖框(content 的第一段請用 \"frame\":{\"new\":{...}} 開一張新圖)。".to_string()
    } else {
        let lst: Vec<String> = frames.iter().enumerate().map(|(i, f)| format!("  {}: [{}] {}", i, board_type(&f.typ).label, f.title)).collect();
        format!("\n\n目前畫布上的圖框(frame,content 用 frame 欄指定要畫進哪張):\n{}", lst.join("\n"))
    };
    let ref_block = format!("\n\n【板型對照表】(依你選的 frame 的板型,套用對應的配色與連線意義)\n{}", types_brief());
    let frame_idx: std::collections::HashMap<&str, usize> = frames.iter().enumerate().map(|(i, f)| (f.id.as_str(), i)).collect();
    let existing_block = if existing.is_empty() {
        String::new()
    } else {
        let lst: Vec<String> = existing.iter().enumerate().map(|(i, c)| {
            let fi = c.frame_id.as_deref().and_then(|fid| frame_idx.get(fid)).map(|x| format!("(圖框{}) ", x)).unwrap_or_default();
            let mut meta = vec![kind_zh(&c.color).to_string()];
            if let Some(o) = &c.owner {
                meta.push(format!("負責:{}", o));
            }
            if let Some(t) = &c.tags {
                if !t.is_empty() {
                    meta.push(format!("#{}", t.join(" #")));
                }
            }
            format!("  索引{} (卡上編號{}): {}[{}] {}", i, i + 1, fi, meta.join(" "), c.text)
        }).collect();
        format!("\n\n目前所有便利貼(全域索引 0..{}):\n{}\n(新增便利貼索引從 {} 開始)", existing.len().saturating_sub(1), lst.join("\n"), existing.len())
    };
    let ctx_block = if context.is_empty() {
        String::new()
    } else {
        format!("\n\n剛才的會議逐字稿(脈絡,最新在最後;用來理解現在這句話在討論什麼,別把它當成新內容重複建卡):\n{}", context.join("\n"))
    };
    let user = format!("使用者這段話(三引號內,可能是會議內容、也可能是給你的指令):\n\"\"\"\n{}\n\"\"\"{}{}{}{}{}{}", transcript, ctx_block, glossary_block, topic_block, frames_block, ref_block, existing_block);
    let messages = vec![Msg { role: "system", content: crate::prompts::prompt("board-agent") }, Msg { role: "user", content: user }];
    let (text, provider) = chat(&messages, true, local_only, llm).await?;
    Ok((parse_result(&text, existing.len()), provider))
}

pub async fn plan_card_edit(transcript: &str, text: &str, owner: Option<&str>, tags: Option<&[String]>, local_only: bool, llm: &LlmOpts) -> Result<CardEdit, String> {
    let sys = crate::prompts::prompt("card-edit");
    let mut meta = vec![format!("文字「{}」", text)];
    if let Some(o) = owner {
        meta.push(format!("負責人「{}」", o));
    }
    if let Some(t) = tags {
        if !t.is_empty() {
            meta.push(format!("標籤 {}", t.join("、")));
        }
    }
    let user = format!("這張便利貼目前:{}。\n口述修改(三引號內):\n\"\"\"\n{}\n\"\"\"", meta.join(","), transcript);
    let (out, _p) = chat(&[Msg { role: "system", content: sys.to_string() }, Msg { role: "user", content: user }], true, local_only, llm).await?;
    let mut edit = CardEdit::default();
    if let Some(obj) = extract_json(&out) {
        if let Some(t) = obj.get("text").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            edit.text = Some(t.chars().take(40).collect());
        }
        if let Some(arr) = obj.get("tags").and_then(|v| v.as_array()) {
            edit.tags = Some(arr.iter().filter_map(|t| t.as_str()).filter(|t| !t.trim().is_empty()).take(3).map(|t| t.trim().chars().take(8).collect()).collect());
        }
        if let Some(o) = obj.get("owner").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            edit.owner = Some(o.trim().chars().take(10).collect());
        }
        if let Some(c) = obj.get("kind").and_then(|v| v.as_str()).and_then(color_by_kind) {
            edit.color = Some(c.to_string());
        }
    } else if !transcript.trim().is_empty() {
        edit.text = Some(transcript.trim().chars().take(40).collect());
    }
    Ok(edit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_strips_fences_and_think() {
        assert!(extract_json("```json\n{\"a\":1}\n```").is_some());
        assert!(extract_json("<think>reasoning…</think>\n{\"a\":1}").unwrap().get("a").is_some());
        assert!(extract_json("no json here").is_none());
    }

    fn cmd(raw: &str, existing: usize) -> Option<AgentCommand> {
        match parse_result(raw, existing) {
            AgentResult::Command(c) => Some(c),
            _ => None,
        }
    }

    #[test]
    fn parses_edit_command() {
        let c = cmd(r#"{"intent":"command","command":{"action":"edit","index":0,"text":"季繳方案"}}"#, 2);
        assert!(matches!(c, Some(AgentCommand::Edit { index: 0, .. })));
    }

    #[test]
    fn parses_move_and_zones() {
        assert!(matches!(
            cmd(r#"{"intent":"command","command":{"action":"move","index":1,"frame":2}}"#, 3),
            Some(AgentCommand::Move { index: 1, frame: 2 })
        ));
        match cmd(r#"{"intent":"command","command":{"action":"zones","titles":["臨時動議","待討論"]}}"#, 0) {
            Some(AgentCommand::Zones { titles }) => assert_eq!(titles, vec!["臨時動議", "待討論"]),
            other => panic!("expected zones, got {:?}", matches!(other, Some(_))),
        }
    }

    #[test]
    fn parses_connect_between_existing() {
        assert!(matches!(
            cmd(r#"{"intent":"command","command":{"action":"connect","from":0,"to":2}}"#, 3),
            Some(AgentCommand::Connect { from: 0, to: 2 })
        ));
        // self-connect (from == to) is rejected
        assert!(cmd(r#"{"intent":"command","command":{"action":"connect","from":1,"to":1}}"#, 3).is_none());
    }

    #[test]
    fn edit_out_of_range_is_rejected() {
        // index 5 but only 1 existing card -> not a valid command -> falls back to content
        assert!(cmd(r#"{"intent":"command","command":{"action":"edit","index":5,"text":"X"}}"#, 1).is_none());
    }

    #[test]
    fn parses_content_with_stickies_and_connectors() {
        let r = parse_result(r#"{"intent":"content","stickies":[{"text":"A","color":"yellow"},{"text":"B","color":"green"}],"connectors":[{"from":0,"to":1}]}"#, 0);
        match r {
            AgentResult::Content(p) => {
                assert_eq!(p.stickies.len(), 2);
                assert_eq!(p.connectors, vec![(0, 1)]);
            }
            _ => panic!("expected content"),
        }
    }

    #[test]
    fn kind_maps_to_color() {
        let r = parse_result(r#"{"intent":"content","stickies":[{"text":"待辦事項","kind":"todo"}]}"#, 0);
        if let AgentResult::Content(p) = r {
            assert_eq!(p.stickies[0].color, "green"); // todo -> green
        } else {
            panic!()
        }
    }

    #[test]
    fn bad_connector_index_dropped() {
        // connector referencing index 9 (out of range) is dropped, not panicked
        let r = parse_result(r#"{"intent":"content","stickies":[{"text":"A"}],"connectors":[{"from":0,"to":9}]}"#, 0);
        if let AgentResult::Content(p) = r {
            assert!(p.connectors.is_empty());
        } else {
            panic!()
        }
    }
}
