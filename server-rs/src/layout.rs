//! Port of the layout positioners + frame-aware tidy from sync-server.ts.
//! Operates on plain data (cards/connectors/frames); returns id->(x,y) positions
//! and per-frame sizes, which the caller applies in a yrs transaction.
use crate::board_types::board_type;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const CARD_W: f64 = 200.0;
pub const CARD_H: f64 = 200.0;
const COL_GAP: f64 = 50.0;
const ROW_GAP: f64 = 36.0;
pub const X0: f64 = 120.0;
pub const Y0: f64 = 120.0;
const FRAME_PAD: f64 = 28.0;
const FRAME_HEAD: f64 = 60.0;
const COL_ORDER: [&str; 4] = ["yellow", "green", "blue", "red"];

#[derive(Clone)]
pub struct Card {
    pub id: String,
    pub color: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub frame_id: Option<String>,
    pub owner: Option<String>,
}

fn numf(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(d)
}
pub fn card_from(v: &Value) -> Option<Card> {
    if v.get("type").and_then(|t| t.as_str()) != Some("sticky") {
        return None;
    }
    Some(Card {
        id: v.get("id")?.as_str()?.to_string(),
        color: v.get("color").and_then(|c| c.as_str()).unwrap_or("yellow").to_string(),
        x: numf(v, "x", 0.0),
        y: numf(v, "y", 0.0),
        w: numf(v, "w", CARD_W),
        h: numf(v, "h", CARD_H),
        frame_id: v.get("frameId").and_then(|f| f.as_str()).map(|s| s.to_string()),
        owner: v.get("owner").and_then(|o| o.as_str()).map(|s| s.to_string()),
    })
}

fn column_of(color: &str) -> usize {
    COL_ORDER.iter().position(|c| *c == color).unwrap_or(COL_ORDER.len())
}

pub fn conn_pairs(conns: &[Value]) -> Vec<(String, String)> {
    conns
        .iter()
        .filter_map(|c| {
            let f = c.get("from")?.as_str()?.to_string();
            let t = c.get("to")?.as_str()?.to_string();
            Some((f, t))
        })
        .collect()
}

type Pos = HashMap<String, (f64, f64)>;

fn build_graph(cards: &[Card], conns: &[(String, String)]) -> (Vec<String>, HashMap<String, Vec<String>>, HashMap<String, usize>) {
    let ids: Vec<String> = cards.iter().map(|c| c.id.clone()).collect();
    let idset: HashSet<&String> = ids.iter().collect();
    let mut children: HashMap<String, Vec<String>> = ids.iter().map(|id| (id.clone(), vec![])).collect();
    let mut indeg: HashMap<String, usize> = ids.iter().map(|id| (id.clone(), 0)).collect();
    for (f, t) in conns {
        if idset.contains(f) && idset.contains(t) && f != t {
            children.get_mut(f).unwrap().push(t.clone());
            *indeg.get_mut(t).unwrap() += 1;
        }
    }
    (ids, children, indeg)
}

fn col_positions(cards: &[Card], ox: f64, oy: f64, sp: f64) -> Pos {
    let mut pos = Pos::new();
    let mut sorted: Vec<&Card> = cards.iter().collect();
    sorted.sort_by(|a, b| {
        column_of(&a.color)
            .cmp(&column_of(&b.color))
            .then(a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut row_by_col: HashMap<usize, usize> = HashMap::new();
    for c in sorted {
        let col = column_of(&c.color);
        let row = *row_by_col.get(&col).unwrap_or(&0);
        row_by_col.insert(col, row + 1);
        pos.insert(c.id.clone(), (ox + col as f64 * (CARD_W + COL_GAP * sp), oy + row as f64 * (CARD_H + ROW_GAP * sp)));
    }
    pos
}

fn levels_longest(ids: &[String], children: &HashMap<String, Vec<String>>, indeg: &HashMap<String, usize>) -> HashMap<String, i64> {
    let mut roots: Vec<String> = ids.iter().filter(|id| *indeg.get(*id).unwrap_or(&0) == 0).cloned().collect();
    if roots.is_empty() && !ids.is_empty() {
        roots.push(ids[0].clone());
    }
    let mut level: HashMap<String, i64> = HashMap::new();
    let mut q: std::collections::VecDeque<(String, i64)> = roots.into_iter().map(|r| (r, 0)).collect();
    let mut guard = 0;
    while let Some((id, lv)) = q.pop_front() {
        guard += 1;
        if guard > 20000 {
            break;
        }
        if *level.get(&id).unwrap_or(&-1) >= lv {
            continue;
        }
        level.insert(id.clone(), lv);
        for ch in children.get(&id).cloned().unwrap_or_default() {
            q.push_back((ch, lv + 1));
        }
    }
    for id in ids {
        level.entry(id.clone()).or_insert(0);
    }
    level
}

fn tree_positions(cards: &[Card], conns: &[(String, String)], ox: f64, oy: f64, dir: &str, sp: f64) -> Pos {
    let mut pos = Pos::new();
    if cards.is_empty() {
        return pos;
    }
    let by_id: HashMap<&String, &Card> = cards.iter().map(|c| (&c.id, c)).collect();
    let (ids, children, indeg) = build_graph(cards, conns);
    let level = levels_longest(&ids, &children, &indeg);
    let mut order = ids.clone();
    order.sort_by(|a, b| {
        let la = *level.get(a).unwrap_or(&0);
        let lb = *level.get(b).unwrap_or(&0);
        la.cmp(&lb).then_with(|| {
            let (ca, cb) = (by_id[a], by_id[b]);
            if dir == "LR" {
                ca.y.partial_cmp(&cb.y).unwrap_or(std::cmp::Ordering::Equal)
            } else {
                ca.x.partial_cmp(&cb.x).unwrap_or(std::cmp::Ordering::Equal)
            }
        })
    });
    let mut by_level: HashMap<i64, Vec<String>> = HashMap::new();
    for id in &order {
        by_level.entry(*level.get(id).unwrap_or(&0)).or_default().push(id.clone());
    }
    let gx = CARD_W + 50.0 * sp;
    let gy = CARD_H + 40.0 * sp;
    for (lv, list) in &by_level {
        for (i, id) in list.iter().enumerate() {
            let p = if dir == "LR" {
                (ox + *lv as f64 * gx, oy + i as f64 * gy)
            } else {
                (ox + i as f64 * gx, oy + *lv as f64 * gy)
            };
            pos.insert(id.clone(), p);
        }
    }
    pos
}

fn radial_positions(cards: &[Card], conns: &[(String, String)], ox: f64, oy: f64, sp: f64) -> Pos {
    let mut pos = Pos::new();
    if cards.is_empty() {
        return pos;
    }
    let (ids, children, indeg) = build_graph(cards, conns);
    let center = ids.iter().find(|id| *indeg.get(*id).unwrap_or(&0) == 0).cloned().unwrap_or_else(|| ids[0].clone());
    // BFS depth from center
    let mut level: HashMap<String, i64> = HashMap::new();
    level.insert(center.clone(), 0);
    let mut q: std::collections::VecDeque<(String, i64)> = std::collections::VecDeque::new();
    q.push_back((center.clone(), 0));
    let mut guard = 0;
    while let Some((id, lv)) = q.pop_front() {
        guard += 1;
        if guard > 20000 {
            break;
        }
        for ch in children.get(&id).cloned().unwrap_or_default() {
            if !level.contains_key(&ch) {
                level.insert(ch.clone(), lv + 1);
                q.push_back((ch, lv + 1));
            }
        }
    }
    for id in &ids {
        level.entry(id.clone()).or_insert(1);
    }
    // leaf counts for angular allocation
    let mut leaves: HashMap<String, f64> = HashMap::new();
    fn count_leaves(id: &str, children: &HashMap<String, Vec<String>>, level: &HashMap<String, i64>, leaves: &mut HashMap<String, f64>, seen: &mut HashSet<String>) -> f64 {
        if seen.contains(id) {
            return 1.0;
        }
        seen.insert(id.to_string());
        let ch: Vec<String> = children.get(id).cloned().unwrap_or_default().into_iter().filter(|k| level.get(k).unwrap_or(&0) > level.get(id).unwrap_or(&0)).collect();
        let c = if ch.is_empty() { 1.0 } else { ch.iter().map(|k| count_leaves(k, children, level, leaves, seen)).sum() };
        leaves.insert(id.to_string(), c);
        c
    }
    count_leaves(&center, &children, &level, &mut leaves, &mut HashSet::new());
    let mut ang: HashMap<String, f64> = HashMap::new();
    fn assign(id: &str, a0: f64, a1: f64, children: &HashMap<String, Vec<String>>, level: &HashMap<String, i64>, leaves: &HashMap<String, f64>, ang: &mut HashMap<String, f64>, seen: &mut HashSet<String>) {
        if seen.contains(id) {
            return;
        }
        seen.insert(id.to_string());
        ang.insert(id.to_string(), (a0 + a1) / 2.0);
        let ch: Vec<String> = children.get(id).cloned().unwrap_or_default().into_iter().filter(|k| level.get(k).unwrap_or(&0) > level.get(id).unwrap_or(&0) && !seen.contains(k)).collect();
        let total: f64 = ch.iter().map(|k| leaves.get(k).copied().unwrap_or(1.0)).sum::<f64>().max(1.0);
        let mut a = a0;
        for k in ch {
            let span = (a1 - a0) * (leaves.get(&k).copied().unwrap_or(1.0) / total);
            assign(&k, a, a + span, children, level, leaves, ang, seen);
            a += span;
        }
    }
    assign(&center, -std::f64::consts::FRAC_PI_2, 3.0 * std::f64::consts::FRAC_PI_2, &children, &level, &leaves, &mut ang, &mut HashSet::new());
    let ring = 200.0 + 40.0 * sp;
    let max_lv = level.values().copied().max().unwrap_or(0).max(0) as f64;
    let cx = ox + ring * max_lv;
    let cy = oy + ring * max_lv;
    for id in &ids {
        let lv = *level.get(id).unwrap_or(&0) as f64;
        if lv == 0.0 {
            pos.insert(id.clone(), (cx, cy));
        } else {
            let a = *ang.get(id).unwrap_or(&0.0);
            pos.insert(id.clone(), (cx + ring * lv * a.cos(), cy + ring * lv * a.sin()));
        }
    }
    pos
}

fn quadrant_positions(cards: &[Card], ox: f64, oy: f64, sp: f64) -> Pos {
    let mut pos = Pos::new();
    let mut g: HashMap<&str, Vec<&Card>> = HashMap::new();
    for c in cards {
        let key = match c.color.as_str() {
            "green" | "yellow" | "blue" | "red" => c.color.as_str(),
            _ => "green",
        };
        g.entry(key).or_default().push(c);
    }
    let gy = 24.0 * sp;
    let empty = vec![];
    let green = g.get("green").unwrap_or(&empty);
    let yellow = g.get("yellow").unwrap_or(&empty);
    let top_rows = green.len().max(yellow.len()) as f64;
    let bot_y = oy + top_rows * (CARD_H + gy) + 80.0;
    let left_x = ox;
    let right_x = ox + CARD_W + 80.0 * sp;
    let mut place = |arr: &Vec<&Card>, x: f64, y0: f64, pos: &mut Pos| {
        for (i, c) in arr.iter().enumerate() {
            pos.insert(c.id.clone(), (x, y0 + i as f64 * (CARD_H + gy)));
        }
    };
    place(green, left_x, oy, &mut pos);
    place(yellow, right_x, oy, &mut pos);
    place(g.get("blue").unwrap_or(&empty), left_x, bot_y, &mut pos);
    place(g.get("red").unwrap_or(&empty), right_x, bot_y, &mut pos);
    pos
}

fn fishbone_positions(cards: &[Card], conns: &[(String, String)], ox: f64, oy: f64, sp: f64) -> Pos {
    let mut pos = Pos::new();
    if cards.is_empty() {
        return pos;
    }
    let (ids, children, _indeg) = build_graph(cards, conns);
    let head = ids.iter().find(|id| children.get(*id).map(|c| c.is_empty()).unwrap_or(true)).cloned().unwrap_or_else(|| ids[0].clone());
    let mut parents: HashMap<String, Vec<String>> = ids.iter().map(|id| (id.clone(), vec![])).collect();
    for f in &ids {
        for t in children.get(f).cloned().unwrap_or_default() {
            parents.get_mut(&t).unwrap().push(f.clone());
        }
    }
    let mut level: HashMap<String, i64> = HashMap::new();
    level.insert(head.clone(), 0);
    let mut q: std::collections::VecDeque<(String, i64)> = std::collections::VecDeque::new();
    q.push_back((head.clone(), 0));
    let mut guard = 0;
    while let Some((id, lv)) = q.pop_front() {
        guard += 1;
        if guard > 20000 {
            break;
        }
        for p in parents.get(&id).cloned().unwrap_or_default() {
            if !level.contains_key(&p) {
                level.insert(p.clone(), lv + 1);
                q.push_back((p, lv + 1));
            }
        }
    }
    for id in &ids {
        level.entry(id.clone()).or_insert(1);
    }
    let mut by_level: HashMap<i64, Vec<String>> = HashMap::new();
    for id in &ids {
        by_level.entry(*level.get(id).unwrap_or(&0)).or_default().push(id.clone());
    }
    let max_lv = level.values().copied().max().unwrap_or(0) as f64;
    let gx = 250.0 * sp;
    let gy = 230.0 * sp;
    let mut max_off = 1.0_f64;
    for (lv, list) in &by_level {
        if *lv > 0 {
            max_off = max_off.max((list.len() as f64 / 2.0).ceil());
        }
    }
    let spine_y = oy + max_off * gy;
    for (lv, list) in &by_level {
        if *lv == 0 {
            pos.insert(list[0].clone(), (ox + max_lv * gx, spine_y));
            continue;
        }
        for (i, id) in list.iter().enumerate() {
            let above = i % 2 == 0;
            let y_off = ((i / 2) as f64 + 1.0) * gy * if above { -1.0 } else { 1.0 };
            pos.insert(id.clone(), (ox + (max_lv - *lv as f64) * gx, spine_y + y_off));
        }
    }
    pos
}

fn gantt_positions(cards: &[Card], conns: &[(String, String)], ox: f64, oy: f64, sp: f64) -> Pos {
    let mut pos = Pos::new();
    if cards.is_empty() {
        return pos;
    }
    let by_id: HashMap<&String, &Card> = cards.iter().map(|c| (&c.id, c)).collect();
    let (ids, children, indeg) = build_graph(cards, conns);
    let mut indeg_c: HashMap<String, i64> = indeg.iter().map(|(k, v)| (k.clone(), *v as i64)).collect();
    let mut queue: Vec<String> = ids.iter().filter(|id| *indeg_c.get(*id).unwrap_or(&0) == 0).cloned().collect();
    queue.sort_by(|a, b| by_id[a].x.partial_cmp(&by_id[b].x).unwrap_or(std::cmp::Ordering::Equal));
    let mut order: Vec<String> = vec![];
    let mut seen: HashSet<String> = HashSet::new();
    let mut guard = 0;
    while let Some(id) = queue.first().cloned() {
        queue.remove(0);
        guard += 1;
        if guard > 20000 {
            break;
        }
        if seen.contains(&id) {
            continue;
        }
        seen.insert(id.clone());
        order.push(id.clone());
        for t in children.get(&id).cloned().unwrap_or_default() {
            let e = indeg_c.entry(t.clone()).or_insert(0);
            *e -= 1;
            if *e <= 0 {
                queue.push(t);
            }
        }
    }
    for id in &ids {
        if !seen.contains(id) {
            order.push(id.clone());
        }
    }
    let mut row_of: HashMap<String, usize> = HashMap::new();
    for id in &order {
        let o = by_id[id].owner.clone().unwrap_or_else(|| "未指派".to_string());
        let next = row_of.len();
        row_of.entry(o).or_insert(next);
    }
    let gx = CARD_W + 40.0 * sp;
    let gy = CARD_H + 30.0 * sp;
    for (col, id) in order.iter().enumerate() {
        let o = by_id[id].owner.clone().unwrap_or_else(|| "未指派".to_string());
        pos.insert(id.clone(), (ox + col as f64 * gx, oy + *row_of.get(&o).unwrap_or(&0) as f64 * gy));
    }
    pos
}

fn layout_positions(type_key: &str, cards: &[Card], conns: &[(String, String)], ox: f64, oy: f64, sp: f64) -> Pos {
    let bt = board_type(type_key);
    match bt.layout {
        "tree" => tree_positions(cards, conns, ox, oy, bt.dir, sp),
        "radial" => radial_positions(cards, conns, ox, oy, sp),
        "quadrant" => quadrant_positions(cards, ox, oy, sp),
        "fishbone" => fishbone_positions(cards, conns, ox, oy, sp),
        "gantt" => gantt_positions(cards, conns, ox, oy, sp),
        _ => col_positions(cards, ox, oy, sp),
    }
}

pub struct Frame {
    pub id: String,
    pub typ: String,
    pub x: f64,
    pub y: f64,
}
pub fn frame_from(v: &Value) -> Option<Frame> {
    Some(Frame {
        id: v.get("id")?.as_str()?.to_string(),
        typ: v.get("type").and_then(|t| t.as_str()).unwrap_or("meeting").to_string(),
        x: numf(v, "x", 80.0),
        y: numf(v, "y", 80.0),
    })
}

/// Returns (card positions, frame sizes). Frameless boards => one whole-board layout.
pub fn tidy(meta_type: &str, shapes: &[Value], conns_v: &[Value], frames_v: &[Value], sp: f64) -> (Vec<(String, f64, f64)>, Vec<(String, f64, f64)>) {
    let cards: Vec<Card> = shapes.iter().filter_map(card_from).collect();
    let conns = conn_pairs(conns_v);
    let frames: Vec<Frame> = frames_v.iter().filter_map(frame_from).collect();
    let mut out_pos: Vec<(String, f64, f64)> = vec![];
    let mut out_frames: Vec<(String, f64, f64)> = vec![];
    if frames.is_empty() {
        let pos = layout_positions(meta_type, &cards, &conns, X0, Y0, sp);
        for (id, (x, y)) in pos {
            out_pos.push((id, x, y));
        }
        return (out_pos, out_frames);
    }
    for f in &frames {
        let fcards: Vec<Card> = cards.iter().filter(|c| c.frame_id.as_deref() == Some(f.id.as_str())).cloned().collect();
        if fcards.is_empty() {
            continue;
        }
        let pos = layout_positions(&f.typ, &fcards, &conns, f.x + FRAME_PAD, f.y + FRAME_HEAD, sp);
        let mut max_x = f.x;
        let mut max_y = f.y;
        for c in &fcards {
            if let Some((x, y)) = pos.get(&c.id) {
                out_pos.push((c.id.clone(), *x, *y));
                max_x = max_x.max(x + c.w);
                max_y = max_y.max(y + c.h);
            }
        }
        let w = (max_x - f.x + FRAME_PAD).max(440.0);
        let h = (max_y - f.y + FRAME_PAD).max(300.0);
        out_frames.push((f.id.clone(), w, h));
    }
    (out_pos, out_frames)
}
