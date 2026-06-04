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

const SYSTEM = `你是會議白板助手。給你一段會議逐字稿,請把重點拆成便利貼,鋪在共享白板上,並用連線表達關係。

只輸出一個 JSON 物件(不要任何說明文字、不要 markdown 圍欄),格式:
{
  "stickies": [ { "text": "<繁中短語,最多 14 字>", "kind": "topic|todo|decision|risk" } ],
  "connectors": [ [<fromIndex>, <toIndex>] ]
}

規則:
- 最多 6 張便利貼。每張 text 是精簡的繁體中文短語(名詞片語),不是整句。
- kind:主題=topic、待辦=todo、決議=decision、風險=risk。
- connectors 是 stickies 陣列的索引配對,表示「導向 / 依賴 / 衍生」。沒有關係就給 []。
- 只根據逐字稿,不得編造逐字稿沒有的內容。`

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
	const connectors: [number, number][] = (Array.isArray(obj.connectors) ? obj.connectors : [])
		.filter(
			(c: any) =>
				Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) &&
				c[0] >= 0 && c[1] >= 0 && c[0] < n && c[1] < n && c[0] !== c[1]
		)
		.map((c: any) => [c[0], c[1]] as [number, number])
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
