/**
 * Board types — the "metadata" that tells the agent what kind of diagram this is,
 * so it interprets cards + connections correctly and the board auto-arranges the
 * right way. The `hint` is injected into the agent prompt; `layout` drives the
 * auto-arrange algorithm; `colors`/`edgeLabel` drive the markdown export.
 */
export type BoardLayout = 'columns' | 'tree'
export type BoardType = {
	key: string
	label: string
	layout: BoardLayout
	dir: 'TB' | 'LR' // tree direction: top-down or left-right
	blurb: string // one-liner for the UI
	hint: string // injected into the agent prompt
	colors: Record<string, string> // what each colour means on this board (for export/legend)
	edgeLabel: string // section title for the connections in the export
}

export const BOARD_TYPES: Record<string, BoardType> = {
	meeting: {
		key: 'meeting',
		label: '會議白板',
		layout: 'columns',
		dir: 'TB',
		blurb: '把討論整理成主題/待辦/決議/風險',
		hint: `這是【會議白板】。卡片=會議重點,用 kind 分類:主題=topic、待辦=todo、決議=decision、風險=risk。連線表示:主題→它衍生的待辦/風險/決議、問題→解法(from=源頭 to=衍生)。owner=負責人(逐字稿明確指出才填)。tags=內容主題(如 前端/金流)。`,
		colors: { yellow: '主題', green: '待辦', blue: '決議', red: '風險' },
		edgeLabel: '關聯',
	},
	orgchart: {
		key: 'orgchart',
		label: '組織架構圖',
		layout: 'tree',
		dir: 'TB',
		blurb: '畫出部門/職位/隸屬關係',
		hint: `這是【組織架構圖】。每張卡=一個職位/部門;text 放職稱或部門名,owner 放擔任者姓名(若有)。用 color 表示層級:blue=最高層(負責人/總經理)、green=中階主管/部門、yellow=基層職位、red=外部/兼任。連線代表「隸屬」,方向 from=上級 to=直屬下屬;務必把每個下屬接到它的直屬上級,讓整張圖連成一棵完整的樹。tags 放部門或職能。不要用待辦/風險等會議概念。`,
		colors: { blue: '最高層', green: '主管/部門', yellow: '基層職位', red: '外部/兼任' },
		edgeLabel: '隸屬(上級 → 下屬)',
	},
	flow: {
		key: 'flow',
		label: '流程圖',
		layout: 'tree',
		dir: 'LR',
		blurb: '把步驟串成先後流程',
		hint: `這是【流程圖】。每張卡=一個步驟;用 color:green=開始、yellow=一般步驟、blue=判斷/分支、red=結束或例外。連線代表「先後順序」,方向 from=前一步 to=下一步;把步驟串成流程(判斷卡可連出多條分支)。不要用會議概念。`,
		colors: { green: '開始', yellow: '步驟', blue: '判斷/分支', red: '結束/例外' },
		edgeLabel: '流程(先 → 後)',
	},
	architecture: {
		key: 'architecture',
		label: '系統架構圖',
		layout: 'tree',
		dir: 'TB',
		blurb: '元件/服務與呼叫依賴',
		hint: `這是【系統架構圖】。每張卡=一個元件/服務/資料源;用 color:blue=前端/介面、green=後端/服務、yellow=資料/儲存、red=外部系統。連線代表「呼叫/依賴」,方向 from=呼叫方 to=被呼叫方。tags 放技術或模組。不要用會議概念。`,
		colors: { blue: '前端/介面', green: '後端/服務', yellow: '資料/儲存', red: '外部系統' },
		edgeLabel: '依賴(呼叫方 → 被呼叫方)',
	},
}

export const DEFAULT_BOARD_TYPE = 'meeting'

export function boardType(key: string | undefined): BoardType {
	return BOARD_TYPES[key || ''] || BOARD_TYPES[DEFAULT_BOARD_TYPE]
}
