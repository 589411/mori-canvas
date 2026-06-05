//! Port of board-types.ts — the 10 board types that drive agent interpretation,
//! layout, and export vocabulary.
use once_cell::sync::Lazy;
use std::collections::HashMap;

#[derive(Clone)]
pub struct BoardType {
    pub key: &'static str,
    pub label: &'static str,
    pub layout: &'static str, // columns | tree | radial | quadrant | fishbone | gantt
    pub dir: &'static str,    // TB | LR
    pub blurb: &'static str,
    pub hint: &'static str,
    pub colors: Vec<(&'static str, &'static str)>, // colour -> meaning, in order blue/green/yellow/red where relevant
    pub edge_label: &'static str,
}

pub const DEFAULT_BOARD_TYPE: &str = "meeting";

pub static BOARD_TYPES: Lazy<Vec<BoardType>> = Lazy::new(|| {
    vec![
        BoardType {
            key: "meeting", label: "會議白板", layout: "columns", dir: "TB",
            blurb: "把討論整理成主題/待辦/決議/風險",
            hint: "這是【會議白板】。卡片=會議重點,用 kind 分類:主題=topic、待辦=todo、決議=decision、風險=risk。連線表示:主題→它衍生的待辦/風險/決議、問題→解法(from=源頭 to=衍生)。owner=負責人(逐字稿明確指出才填)。tags=內容主題(如 前端/金流)。",
            colors: vec![("yellow","主題"),("green","待辦"),("blue","決議"),("red","風險")],
            edge_label: "關聯",
        },
        BoardType {
            key: "orgchart", label: "組織架構圖", layout: "tree", dir: "TB",
            blurb: "畫出部門/職位/隸屬關係",
            hint: "這是【組織架構圖】。每張卡=一個職位/部門;text 放職稱或部門名,owner 放擔任者姓名(若有)。用 color 表示層級:blue=最高層(負責人/總經理)、green=中階主管/部門、yellow=基層職位、red=外部/兼任。連線代表「隸屬」,方向 from=上級 to=直屬下屬;務必把每個下屬接到它的直屬上級,讓整張圖連成一棵完整的樹。tags 放部門或職能。不要用待辦/風險等會議概念。",
            colors: vec![("blue","最高層"),("green","主管/部門"),("yellow","基層職位"),("red","外部/兼任")],
            edge_label: "隸屬(上級 → 下屬)",
        },
        BoardType {
            key: "flow", label: "流程圖", layout: "tree", dir: "LR",
            blurb: "把步驟串成先後流程",
            hint: "這是【流程圖】。每張卡=一個步驟;用 color:green=開始、yellow=一般步驟、blue=判斷/分支、red=結束或例外。連線代表「先後順序」,方向 from=前一步 to=下一步;把步驟串成流程(判斷卡可連出多條分支)。不要用會議概念。",
            colors: vec![("green","開始"),("yellow","步驟"),("blue","判斷/分支"),("red","結束/例外")],
            edge_label: "流程(先 → 後)",
        },
        BoardType {
            key: "architecture", label: "系統架構圖", layout: "tree", dir: "TB",
            blurb: "元件/服務與呼叫依賴",
            hint: "這是【系統架構圖】。每張卡=一個元件/服務/資料源;用 color:blue=前端/介面、green=後端/服務、yellow=資料/儲存、red=外部系統。連線代表「呼叫/依賴」,方向 from=呼叫方 to=被呼叫方。tags 放技術或模組。不要用會議概念。",
            colors: vec![("blue","前端/介面"),("green","後端/服務"),("yellow","資料/儲存"),("red","外部系統")],
            edge_label: "依賴(呼叫方 → 被呼叫方)",
        },
        BoardType {
            key: "mindmap", label: "心智圖", layout: "radial", dir: "TB",
            blurb: "中心主題向外發散的腦力激盪",
            hint: "這是【心智圖】。第一張卡(index 0)= 中心主題;其餘卡 = 由中心發散的子概念、再發散的孫概念。用 color 表示層級:blue=中心、green=第一層分支、yellow=第二層、red=細節。連線一律 from=上層概念 to=它的下層概念,連成一棵由中心發散的樹。不要用會議概念。",
            colors: vec![("blue","中心"),("green","主幹"),("yellow","分支"),("red","細節")],
            edge_label: "發散(上層 → 下層)",
        },
        BoardType {
            key: "kanban", label: "看板", layout: "columns", dir: "TB",
            blurb: "依狀態分欄的任務看板",
            hint: "這是【任務看板 Kanban】。每張卡=一個任務;用 color 表示狀態:red=待辦、yellow=進行中、green=已完成、blue=阻塞/擱置。owner=負責人。同一任務隨討論可被移動狀態(用 updates 改 color)。通常不需要連線。不要套會議概念。",
            colors: vec![("red","待辦"),("yellow","進行中"),("green","已完成"),("blue","阻塞/擱置")],
            edge_label: "相依(先 → 後)",
        },
        BoardType {
            key: "swot", label: "SWOT / 矩陣", layout: "quadrant", dir: "TB",
            blurb: "四象限分析(優勢/劣勢/機會/威脅)",
            hint: "這是【SWOT 四象限分析】。每張卡=一個分析點,用 color 表示象限:green=優勢(S)、yellow=劣勢(W)、blue=機會(O)、red=威脅(T)。通常不需要連線。不要套會議概念。",
            colors: vec![("green","優勢 S"),("yellow","劣勢 W"),("blue","機會 O"),("red","威脅 T")],
            edge_label: "關聯",
        },
        BoardType {
            key: "timeline", label: "時間軸", layout: "tree", dir: "LR",
            blurb: "依時間先後排列的事件/里程碑",
            hint: "這是【時間軸】。每張卡=一個事件/里程碑/階段,text 可含時間。用 color:green=已完成、yellow=進行中、blue=規劃中、red=延遲/風險。連線 from=較早 to=較晚,把事件依時間先後串成一條線。不要套會議概念。",
            colors: vec![("green","已完成"),("yellow","進行中"),("blue","規劃中"),("red","延遲/風險")],
            edge_label: "時序(早 → 晚)",
        },
        BoardType {
            key: "fishbone", label: "魚骨圖", layout: "fishbone", dir: "LR",
            blurb: "問題的因果分析(石川圖)",
            hint: "這是【魚骨圖 / 因果圖】。先有一張「問題/結果」卡(放魚頭,color blue);再把造成它的「主要原因分類」用 green;每個分類底下的「次要原因」用 yellow,特別關鍵的因素用 red。連線方向 from=原因 to=它造成的結果。務必讓所有原因最終都連到那張問題卡。不要套會議概念。",
            colors: vec![("blue","問題/結果"),("green","主因分類"),("yellow","次要原因"),("red","關鍵因素")],
            edge_label: "因果(原因 → 結果)",
        },
        BoardType {
            key: "gantt", label: "甘特圖 / 排程", layout: "gantt", dir: "LR",
            blurb: "任務排程:誰、何時、做什麼(列=負責人)",
            hint: "這是【甘特圖 / 排程表】。每張卡=一個任務,text 含任務名,owner=負責人(盡量填,會用來分列)。用 color:green=已完成、yellow=進行中、blue=未開始、red=延遲/卡關。連線 from=要先做的 to=接著做的,把任務依時間先後串起來。不要套會議概念。",
            colors: vec![("green","已完成"),("yellow","進行中"),("blue","未開始"),("red","延遲/卡關")],
            edge_label: "相依(先 → 後)",
        },
    ]
});

pub fn board_type(key: &str) -> &'static BoardType {
    BOARD_TYPES.iter().find(|t| t.key == key).unwrap_or_else(|| BOARD_TYPES.iter().find(|t| t.key == DEFAULT_BOARD_TYPE).unwrap())
}

pub fn color_label(bt: &BoardType, color: &str) -> Option<&'static str> {
    bt.colors.iter().find(|(c, _)| *c == color).map(|(_, l)| *l)
}

/// compact reference for all types — fed to the agent so it can pick + interpret any frame
pub fn types_brief() -> String {
    BOARD_TYPES
        .iter()
        .map(|t| {
            let cols = t.colors.iter().map(|(c, l)| format!("{}={}", c, l)).collect::<Vec<_>>().join("、");
            format!("- {}({}):配色 {};連線={}", t.key, t.label, cols, t.edge_label)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// types for the client picker (key/label/blurb)
pub fn types_list() -> Vec<HashMap<&'static str, &'static str>> {
    BOARD_TYPES
        .iter()
        .map(|t| {
            let mut m = HashMap::new();
            m.insert("key", t.key);
            m.insert("label", t.label);
            m.insert("blurb", t.blurb);
            m
        })
        .collect()
}
