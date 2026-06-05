//! applyPlan + runCommand + runAgentTurn — orchestration that writes agent output
//! into a room's yrs doc. Port of the corresponding sync-server.ts logic (batch
//! apply; the streaming Mori-cursor effect is a later polish).
use crate::agent::{plan_agent, AgentCommand, AgentResult, BoardPlan, ExistingCard, FrameInfo, FrameTarget, StickyPlan};
use crate::board_types::board_type;
use crate::layout;
use crate::store::{self, rid};
use crate::sync::Room;
use crate::yval::{any_to_json, json_to_any};
use serde_json::{json, Value};
use yrs::types::ToJson;
use yrs::{Map, Transact};

const COL_ORDER: [&str; 4] = ["yellow", "green", "blue", "red"];
fn column_of(color: &str) -> usize {
    COL_ORDER.iter().position(|c| *c == color).unwrap_or(COL_ORDER.len())
}

/// existing stickies in a STABLE order (by id) — same order fed to the agent.
pub fn existing_stickies(room: &Room) -> Vec<ExistingCard> {
    let mut shapes = store::read_map(room, "shapes");
    shapes.retain(|s| s.get("type").and_then(|v| v.as_str()) == Some("sticky"));
    shapes.sort_by(|a, b| a.get("id").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("id").and_then(|v| v.as_str()).unwrap_or("")));
    shapes
        .iter()
        .map(|s| ExistingCard {
            id: s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            text: s.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            color: s.get("color").and_then(|v| v.as_str()).unwrap_or("yellow").to_string(),
            owner: s.get("owner").and_then(|v| v.as_str()).map(|x| x.to_string()),
            tags: s.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|t| t.as_str().map(|x| x.to_string())).collect()),
            frame_id: s.get("frameId").and_then(|v| v.as_str()).map(|x| x.to_string()),
        })
        .collect()
}

pub fn frames_info(room: &Room) -> Vec<FrameInfo> {
    store::frames_sorted(room)
        .iter()
        .map(|f| FrameInfo {
            id: f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            title: f.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            typ: f.get("type").and_then(|v| v.as_str()).unwrap_or("meeting").to_string(),
        })
        .collect()
}

pub fn tidy_board(room: &Room, spacing: f64) {
    let (mtype, _) = store::read_meta(room);
    let shapes = store::read_map(room, "shapes");
    let conns = store::read_map(room, "connectors");
    let frames = store::read_map(room, "frames");
    let (pos, fsz) = layout::tidy(&mtype, &shapes, &conns, &frames, spacing);
    store::apply_tidy(room, &pos, &fsz);
}

fn sticky_json(id: &str, s: &StickyPlan, x: f64, y: f64, drawn_by: &str, frame_id: Option<&str>) -> Value {
    let mut o = json!({ "id": id, "type": "sticky", "x": x, "y": y, "w": 200.0, "h": 200.0, "text": s.text, "color": s.color, "drawnBy": drawn_by });
    if let Some(fid) = frame_id {
        o["frameId"] = json!(fid);
    }
    if let Some(owner) = &s.owner {
        o["owner"] = json!(owner);
    }
    if let Some(tags) = &s.tags {
        if !tags.is_empty() {
            o["tags"] = json!(tags);
        }
    }
    o
}

/// returns (new_ids, connectors_drawn)
/// publish (or clear) "Mori"'s live cursor on a room via awareness, so every client sees it
fn set_mori_cursor(room: &Room, cursor: Option<(f64, f64)>) {
    match cursor {
        Some((x, y)) => {
            let _ = room.awareness.set_local_state(json!({ "user": { "name": "Mori", "color": "#7c3aed" }, "cursor": { "x": x, "y": y } }));
        }
        None => room.awareness.clean_local_state(),
    }
}

/// Stream new stickies one-by-one with Mori's live cursor moving to each (the "Mori draws"
/// effect), like the Node version. Each phase is its own transaction so no txn is held
/// across an await. Returns (new_ids, connectors_drawn).
pub async fn apply_plan(room: &Room, plan: &BoardPlan, drawn_by: &str, existing_ids: &[String], frame_id: Option<&str>) -> (Vec<String>, usize) {
    let e = existing_ids.len();

    // 1) updates + deletes (one transaction)
    {
        let doc = room.awareness.doc();
        let shapes = doc.get_or_insert_map("shapes");
        let connectors = doc.get_or_insert_map("connectors");
        let mut txn = doc.transact_mut();
        for u in &plan.updates {
            if let Some(id) = existing_ids.get(u.index) {
                if let Some(cur) = shapes.get(&txn, id) {
                    let mut v = any_to_json(&cur.to_json(&txn));
                    if let Some(t) = &u.text {
                        v["text"] = json!(t);
                    }
                    if let Some(c) = &u.color {
                        v["color"] = json!(c);
                    }
                    shapes.insert(&mut txn, id.clone(), json_to_any(&v));
                }
            }
        }
        for idx in &plan.deletes {
            if let Some(id) = existing_ids.get(*idx) {
                if shapes.get(&txn, id).is_some() {
                    shapes.remove(&mut txn, id);
                    let conn_keys: Vec<String> = connectors
                        .iter(&txn)
                        .filter_map(|(k, v)| {
                            let j = any_to_json(&v.to_json(&txn));
                            if j.get("from").and_then(|x| x.as_str()) == Some(id.as_str()) || j.get("to").and_then(|x| x.as_str()) == Some(id.as_str()) {
                                Some(k.to_string())
                            } else {
                                None
                            }
                        })
                        .collect();
                    for k in conn_keys {
                        connectors.remove(&mut txn, &k);
                    }
                }
            }
        }
    }

    // 2) stream new stickies — cursor to each, sleep, write (each its own txn)
    let mut new_ids = vec![];
    for (i, s) in plan.stickies.iter().enumerate() {
        let id = format!("sticky-{}", rid());
        let col = column_of(&s.color);
        let x = 120.0 + col as f64 * 240.0;
        let y = 120.0 + i as f64 * 60.0;
        set_mori_cursor(room, Some((x + 100.0, y + 100.0)));
        tokio::time::sleep(std::time::Duration::from_millis(240)).await;
        {
            let doc = room.awareness.doc();
            let shapes = doc.get_or_insert_map("shapes");
            let mut txn = doc.transact_mut();
            shapes.insert(&mut txn, id.clone(), json_to_any(&sticky_json(&id, s, x, y, drawn_by, frame_id)));
        }
        new_ids.push(id);
    }

    // 3) connectors (one transaction, unified index space)
    let mut drawn = 0usize;
    {
        let doc = room.awareness.doc();
        let shapes = doc.get_or_insert_map("shapes");
        let connectors = doc.get_or_insert_map("connectors");
        let mut txn = doc.transact_mut();
        let resolve = |idx: i64| -> Option<String> {
            let idx = idx as usize;
            if idx < e {
                existing_ids.get(idx).cloned()
            } else {
                new_ids.get(idx - e).cloned()
            }
        };
        for (a, b) in &plan.connectors {
            if let (Some(from), Some(to)) = (resolve(*a), resolve(*b)) {
                if from != to && shapes.get(&txn, &from).is_some() && shapes.get(&txn, &to).is_some() {
                    let cid = format!("conn-{}", rid());
                    connectors.insert(&mut txn, cid.clone(), json_to_any(&json!({ "id": cid, "from": from, "to": to })));
                    drawn += 1;
                }
            }
        }
    }
    set_mori_cursor(room, None);
    (new_ids, drawn)
}

/// returns (human label, optional view command for the client)
pub fn run_command(room: &Room, existing: &[ExistingCard], cmd: &AgentCommand, spacing: f64) -> (String, Option<Value>) {
    let patch = |id: &str, f: &dyn Fn(&mut Value)| {
        let doc = room.awareness.doc();
        let shapes = doc.get_or_insert_map("shapes");
        let mut txn = doc.transact_mut();
        if let Some(cur) = shapes.get(&txn, id) {
            let mut v = any_to_json(&cur.to_json(&txn));
            f(&mut v);
            shapes.insert(&mut txn, id.to_string(), json_to_any(&v));
        }
    };
    match cmd {
        AgentCommand::Tidy => {
            tidy_board(room, spacing);
            ("自動排列".into(), None)
        }
        AgentCommand::Filter { by, value } => {
            let label = if by == "tag" { format!("只看 #{}", value) } else { format!("只看 {}", value) };
            (label, Some(json!({ "action": "filter", "by": by, "value": value })))
        }
        AgentCommand::ClearFilter => ("顯示全部".into(), Some(json!({ "action": "clearFilter" }))),
        AgentCommand::Assign { index, owner } => {
            if let Some(c) = existing.get(*index) {
                patch(&c.id, &|v| v["owner"] = json!(owner));
                (format!("指派「{}」給 {}", c.text, owner), None)
            } else {
                ("指派失敗".into(), None)
            }
        }
        AgentCommand::Recolor { index, kind } => {
            if let Some(c) = existing.get(*index) {
                if let Some(color) = crate::agent::color_by_kind(kind) {
                    patch(&c.id, &|v| v["color"] = json!(color));
                    return (format!("「{}」改色", c.text), None);
                }
            }
            ("改色失敗".into(), None)
        }
        AgentCommand::Tag { index, tags } => {
            if let Some(c) = existing.get(*index) {
                let mut merged: Vec<String> = c.tags.clone().unwrap_or_default();
                for t in tags {
                    if !merged.contains(t) {
                        merged.push(t.clone());
                    }
                }
                merged.truncate(3);
                patch(&c.id, &|v| v["tags"] = json!(merged));
                (format!("「{}」加上 #{}", c.text, tags.join(" #")), None)
            } else {
                ("加標籤失敗".into(), None)
            }
        }
        AgentCommand::Edit { index, text } => {
            if let Some(c) = existing.get(*index) {
                patch(&c.id, &|v| v["text"] = json!(text));
                (format!("「{}」改寫為「{}」", c.text, text), None)
            } else {
                ("改寫失敗".into(), None)
            }
        }
    }
}

pub fn card_current(room: &Room, id: &str) -> Option<(String, Option<String>, Option<Vec<String>>)> {
    store::read_map(room, "shapes").into_iter().find(|s| s.get("id").and_then(|v| v.as_str()) == Some(id)).map(|s| {
        (
            s.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            s.get("owner").and_then(|v| v.as_str()).map(|x| x.to_string()),
            s.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|t| t.as_str().map(|x| x.to_string())).collect()),
        )
    })
}

pub fn apply_card_edit(room: &Room, card_id: &str, edit: &crate::agent::CardEdit) -> bool {
    let doc = room.awareness.doc();
    let shapes = doc.get_or_insert_map("shapes");
    let mut txn = doc.transact_mut();
    if let Some(cur) = shapes.get(&txn, card_id) {
        let mut v = any_to_json(&cur.to_json(&txn));
        if let Some(t) = &edit.text {
            v["text"] = json!(t);
        }
        if let Some(t) = &edit.tags {
            v["tags"] = json!(t);
        }
        if let Some(o) = &edit.owner {
            v["owner"] = json!(o);
        }
        if let Some(c) = &edit.color {
            v["color"] = json!(c);
        }
        shapes.insert(&mut txn, card_id.to_string(), json_to_any(&v));
        true
    } else {
        false
    }
}

pub async fn run_agent_turn(room: &Room, transcript: &str, by: &str, local_only: bool, auto_tidy: bool, spacing: f64) -> Result<Value, String> {
    let (mtype, topic) = store::read_meta(room);
    let existing = existing_stickies(room);
    let frames = frames_info(room);
    let (result, provider) = plan_agent(transcript, &existing, &topic, &frames, local_only).await?;
    match result {
        AgentResult::Command(cmd) => {
            let (label, view) = run_command(room, &existing, &cmd, spacing);
            Ok(json!({ "ok": true, "provider": provider, "intent": "command", "command": view, "commandLabel": label, "added": [], "stickies": 0, "connectors": 0 }))
        }
        AgentResult::Content(plan) => {
            // resolve frame
            let mut frame_label = String::new();
            let frame_id: String = match &plan.frame {
                Some(FrameTarget::New { typ, title }) => {
                    let f = store::create_frame(room, typ, title);
                    frame_label = format!("開新圖:{}「{}」", board_type(typ).label, f.get("title").and_then(|v| v.as_str()).unwrap_or(""));
                    f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
                }
                Some(FrameTarget::Index(i)) if *i < frames.len() => frames[*i].id.clone(),
                _ => {
                    if let Some(f0) = frames.first() {
                        f0.id.clone()
                    } else {
                        let f = store::create_frame(room, &mtype, if topic.is_empty() { board_type(&mtype).label } else { &topic });
                        frame_label = format!("開新圖:{}", board_type(&mtype).label);
                        f.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
                    }
                }
            };
            let existing_ids: Vec<String> = existing.iter().map(|c| c.id.clone()).collect();
            let added: Vec<Value> = plan.stickies.iter().map(|s| json!({ "text": s.text, "color": s.color })).collect();
            let (ids, drawn) = apply_plan(room, &plan, by, &existing_ids, Some(&frame_id)).await;
            if auto_tidy && (!ids.is_empty() || drawn > 0) {
                tidy_board(room, spacing);
            }
            Ok(json!({ "ok": true, "provider": provider, "intent": "content", "added": added, "ids": ids, "stickies": ids.len(), "connectors": drawn, "frameLabel": frame_label }))
        }
    }
}
