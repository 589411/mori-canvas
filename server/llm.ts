/**
 * LLM cascade — reuses the mori-meeting-recorder pattern:
 *   cloud-first Groq (openai/gpt-oss-120b) -> local Ollama (qwen3) fallback.
 * Key + model come from the shared ~/.mori/config.json (providers.groq / providers.ollama),
 * exactly like the recorder, so this spike rides the same config as the rest of the universe.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

function moriConfig(): any {
	try {
		return JSON.parse(readFileSync(join(homedir(), '.mori', 'config.json'), 'utf8'))
	} catch {
		return {}
	}
}

function isPlaceholder(k: string): boolean {
	return /^REPLACE/.test(k) || /YOUR_GROQ/.test(k) || k === 'TODO'
}

export function groqKey(): string | null {
	const env = process.env.GROQ_API_KEY
	if (env && env.length && !isPlaceholder(env)) return env
	const k = moriConfig()?.providers?.groq?.api_key
	return k && !isPlaceholder(k) ? k : null
}

async function callGroq(messages: Msg[], json: boolean): Promise<string> {
	const key = groqKey()
	if (!key) throw new Error('no groq api key')
	const model = moriConfig()?.providers?.groq?.model ?? 'openai/gpt-oss-120b'
	const body: any = { model, messages }
	if (json) body.response_format = { type: 'json_object' }
	const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`)
	const data: any = await res.json()
	const content = data?.choices?.[0]?.message?.content
	if (typeof content !== 'string') throw new Error('groq: no choices[0].message.content')
	return content
}

async function callOllama(messages: Msg[], json: boolean): Promise<string> {
	const cfg = moriConfig()
	const base = cfg?.providers?.ollama?.base_url ?? 'http://localhost:11434'
	const model = cfg?.providers?.ollama?.model ?? 'qwen3:8b'
	// think:false — qwen3 is a thinking model; leaving it on burns CPU and can leak <think> (README gotcha #5)
	const body: any = { model, messages, stream: false, think: false, options: { num_ctx: 8192 } }
	if (json) body.format = 'json'
	let res: Response
	try {
		res = await fetch(`${base.replace(/\/$/, '')}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
	} catch (e) {
		throw new Error(`ollama unreachable at ${base} — is 'ollama serve' running? (${(e as Error).message})`)
	}
	if (!res.ok) throw new Error(`ollama ${res.status}`)
	const data: any = await res.json()
	const content = data?.message?.content
	if (typeof content !== 'string') throw new Error('ollama: no message.content')
	return content
}

/** Try Groq first; on any failure fall back to local Ollama. */
export async function chat(messages: Msg[], opts: { json?: boolean } = {}): Promise<{ text: string; provider: string }> {
	const json = !!opts.json
	// LLM_LOCAL_ONLY=1 → never call the cloud; meeting transcripts stay on the LAN.
	if (process.env.LLM_LOCAL_ONLY === '1') {
		return { text: await callOllama(messages, json), provider: 'ollama(local-only)' }
	}
	try {
		return { text: await callGroq(messages, json), provider: 'groq:gpt-oss-120b' }
	} catch (e) {
		const groqErr = (e as Error).message
		console.warn(`[llm] groq failed (${groqErr}); falling back to ollama`)
		try {
			return { text: await callOllama(messages, json), provider: 'ollama' }
		} catch (oe) {
			throw new Error(`both LLM providers failed — groq: ${groqErr}; ollama: ${(oe as Error).message}`)
		}
	}
}
