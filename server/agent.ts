/**
 * The agent: meeting transcript -> a whiteboard plan (sticky notes + connectors).
 * Uses the Groq->Ollama cascade. Output is structured JSON, parsed leniently
 * (strips <think> blocks / code fences, then takes the outer {...}).
 */
import { chat } from './llm.ts'

export type StickyPlan = { text: string; color: string; kind?: string }
export type BoardPlan = { stickies: StickyPlan[]; connectors: [number, number][] }

const COLOR_BY_KIND: Record<string, string> = {
	topic: 'yellow',
	todo: 'green',
	decision: 'blue',
	risk: 'red',
}

const SYSTEM = `你是會議白板助手。給你一段會議逐字稿,把重點拆成便利貼鋪在白板上,並用連線表達它們之間的關係。

只輸出一個 JSON 物件(不要任何說明文字、不要 markdown 圍欄、不要 <think>),格式:
{
  "stickies": [ { "text": "<繁中短語,最多 14 字>", "kind": "topic|todo|decision|risk" } ],
  "connectors": [ { "from": <索引整數>, "to": <索引整數> } ]
}

規則:
- 最多 6 張便利貼。每張 text 是精簡的繁體中文短語(名詞片語),不是整句,別超過 14 字。
- kind:主題=topic、待辦=todo、決議=decision、風險=risk。
- connectors 用 from/to 兩個「便利貼索引」(從 0 開始)表達關係:主題衍生出的待辦/風險/決議、問題對應的解法。**畫關係連線是正常整理、不算編造**,只要兩張在邏輯上相關就連,盡量連 2~4 條。
- from / to 一定是分開的兩個整數,不要黏成一個數字或字串。
- 只根據逐字稿,不得編造逐字稿沒有的「內容」(但連線屬於整理關係,可放心畫)。

範例:
{"stickies":[{"text":"線上預約系統","kind":"topic"},{"text":"重複預約問題","kind":"risk"},{"text":"製作教學影片","kind":"todo"}],"connectors":[{"from":0,"to":1},{"from":0,"to":2}]}`

function parseLenient(raw: string): BoardPlan {
	let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
	s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
	const a = s.indexOf('{')
	const b = s.lastIndexOf('}')
	if (a >= 0 && b > a) s = s.slice(a, b + 1)
	const obj = JSON.parse(s)
	const stickies: StickyPlan[] = (Array.isArray(obj.stickies) ? obj.stickies : [])
		.slice(0, 8)
		.map((x: any) => ({
			text: String(x?.text ?? '').slice(0, 40),
			kind: typeof x?.kind === 'string' ? x.kind : undefined,
			color: COLOR_BY_KIND[x?.kind] ?? (typeof x?.color === 'string' ? x.color : 'yellow'),
		}))
		.filter((x: StickyPlan) => x.text.length > 0)
	const n = stickies.length
	const toIdx = (v: any): number => {
		const x = typeof v === 'number' ? v : parseInt(String(v), 10)
		return Number.isInteger(x) ? x : NaN
	}
	const connectors: [number, number][] = (Array.isArray(obj.connectors) ? obj.connectors : [])
		.map((c: any): [number, number] => {
			// accept {from,to} OR [from,to]
			if (Array.isArray(c) && c.length >= 2) return [toIdx(c[0]), toIdx(c[1])]
			if (c && typeof c === 'object') return [toIdx(c.from), toIdx(c.to)]
			return [NaN, NaN]
		})
		.filter(
			([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a < n && b < n && a !== b
		)
	return { stickies, connectors }
}

export async function planBoard(transcript: string): Promise<{ plan: BoardPlan; provider: string }> {
	const { text, provider } = await chat(
		[
			{ role: 'system', content: SYSTEM },
			{ role: 'user', content: `逐字稿:\n${transcript}` },
		],
		{ json: true }
	)
	return { plan: parseLenient(text), provider }
}
