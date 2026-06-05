/**
 * STT with two processing modes:
 *  - 'mori'   : delegate to mori-ear (--input) — only if ear is installed. Ear itself
 *               routes local-whisper vs Groq per the Mori config.
 *  - 'custom' : this app does it itself, NO mori-ear needed (so it can ship standalone):
 *       cloud → Groq Whisper API (the user's own key);
 *       local → a local whisper-server the user installed (GPU or CPU build — same
 *               approach as mori-meeting-recorder; we just POST to /inference).
 *     Custom mode FIRST trims leading/trailing silence (ffmpeg), so near-silent clips
 *     don't get sent and make Whisper hallucinate (e.g. '(字幕製作:貝爾)').
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { groqKey } from './llm.ts'

const execFileP = promisify(execFile)

export type SttOpts = { mode?: 'mori' | 'custom'; sttSource?: 'cloud' | 'local'; whisperUrl?: string }

function earPath(): string {
	if (process.env.MORI_EAR_BIN) return process.env.MORI_EAR_BIN
	return join(homedir(), '.cargo', 'bin', 'mori-ear')
}
function moriCfg(): any {
	try {
		return JSON.parse(readFileSync(join(homedir(), '.mori', 'config.json'), 'utf8'))
	} catch {
		return {}
	}
}
function whisperServer(): { host: string; port: number; path: string } | null {
	try {
		const w = JSON.parse(readFileSync(join(homedir(), '.mori', 'whisper-server.json'), 'utf8'))
		return { host: w.host || '127.0.0.1', port: w.port || 36969, path: w.inference_path || '/inference' }
	} catch {
		return null
	}
}

/** What's available on this machine — drives which options the settings page offers. */
export function sttCapabilities() {
	return { moriEar: existsSync(earPath()) || !!process.env.MORI_EAR_BIN, whisperServer: !!whisperServer(), groqKey: !!groqKey() }
}

// trim leading + trailing silence (areverse trick). Returns a new wav path, or the
// original if ffmpeg is unavailable. Also normalises to 16k mono wav for whisper.
async function trimSilence(inPath: string): Promise<string> {
	const out = `${inPath}.trim.wav`
	const f = 'silenceremove=start_periods=1:start_silence=0.15:start_threshold=-40dB:detection=peak'
	try {
		await execFileP('ffmpeg', ['-y', '-i', inPath, '-af', `${f},areverse,${f},areverse`, '-ar', '16000', '-ac', '1', out], { timeout: 30_000 })
		return existsSync(out) ? out : inPath
	} catch {
		return inPath // no ffmpeg → skip trimming (whisper still works, just no silence guard)
	}
}
async function durationSec(path: string): Promise<number> {
	try {
		const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 10_000 })
		return parseFloat(stdout.trim()) || 0
	} catch {
		return 1 // can't probe → assume non-empty
	}
}

async function groqWhisper(path: string): Promise<string> {
	const key = groqKey()
	if (!key) throw new Error('雲端 STT 需要 Groq API key(設在 ~/.mori/config.json 或 GROQ_API_KEY)')
	const model = moriCfg()?.providers?.groq?.stt_model ?? 'whisper-large-v3-turbo'
	const fd = new FormData()
	fd.append('file', new Blob([await readFile(path)]), 'audio.wav')
	fd.append('model', model)
	fd.append('response_format', 'json')
	fd.append('language', 'zh')
	const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd })
	if (!res.ok) throw new Error(`groq whisper ${res.status}: ${(await res.text()).slice(0, 200)}`)
	const d: any = await res.json()
	return String(d?.text ?? '').trim()
}

async function localWhisper(path: string, urlOverride?: string): Promise<string> {
	// explicit URL (settings) wins; else the Mori whisper-server descriptor; else a default.
	let url = urlOverride?.trim()
	if (!url) {
		const w = whisperServer() ?? { host: '127.0.0.1', port: 36969, path: '/inference' }
		url = `http://${w.host}:${w.port}${w.path}`
	}
	const fd = new FormData()
	fd.append('file', new Blob([await readFile(path)]), 'audio.wav')
	fd.append('response_format', 'json')
	let res: Response
	try {
		res = await fetch(url, { method: 'POST', body: fd })
	} catch (e) {
		throw new Error(`本機 whisper-server 連不到 ${url} — 有啟動嗎?(${(e as Error).message})`)
	}
	if (!res.ok) throw new Error(`whisper-server ${res.status}`)
	const d: any = await res.json()
	return String(d?.text ?? '').trim()
}

/** Transcribe an audio file. mode 'mori' delegates to ear; 'custom' does it here. */
export async function transcribe(audioPath: string, opts: SttOpts = {}): Promise<string> {
	if ((opts.mode ?? 'mori') === 'mori') {
		const { stdout } = await execFileP(earPath(), ['--input', audioPath], { timeout: 120_000, maxBuffer: 4 << 20 })
		return stdout.trim()
	}
	// custom mode: silence-trim check first (avoids whisper hallucinating on silence)
	const trimmed = await trimSilence(audioPath)
	try {
		if ((await durationSec(trimmed)) < 0.35) return '' // basically silence → skip
		return opts.sttSource === 'local' ? await localWhisper(trimmed, opts.whisperUrl) : await groqWhisper(trimmed)
	} finally {
		if (trimmed !== audioPath) unlink(trimmed).catch(() => {})
	}
}
