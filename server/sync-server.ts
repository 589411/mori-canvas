/**
 * Self-hosted yjs sync server (classic y-websocket wire protocol) + a
 * server-side "bot" that writes shapes into the shared room. 100% FOSS, no
 * license key, no yjs fork — uses the SAME classic `yjs` the clients use, so
 * client->server writes actually integrate (see README gotcha).
 *
 * Chain (identical to the tldraw spike, different canvas/CRDT):
 *   server-side code  ->  shared Y.Doc (Y.Map 'shapes')  ->  every connected browser sees it live
 *
 * - WebSocket sync:  ws://localhost:1234/:room
 * - Bot HTTP:        POST http://localhost:1234/api/bot/:room/sticky  { text?, color? }
 */
import { createServer } from 'node:http'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { writeFile, unlink } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, networkInterfaces } from 'node:os'
import { join as pathJoin } from 'node:path'
import { planAgent, planCardEdit, type BoardPlan, type ExistingCard, type AgentCommand } from './agent.ts'
import { boardType, BOARD_TYPES, DEFAULT_BOARD_TYPE } from './board-types.ts'
import { transcribe } from './stt.ts'
import { chat, setLocalOnly, llmStatus } from './llm.ts'

// runtime settings adjustable from the page's ⚙ (not hardcoded). Global to the server.
const SETTINGS = { spacing: 1, autoTidy: true }
const sp = () => SETTINGS.spacing

const PORT = 1234
const messageSync = 0
const messageAwareness = 1

type Room = {
	doc: Y.Doc
	awareness: awarenessProtocol.Awareness
	conns: Map<WebSocket, Set<number>> // conn -> awareness client ids it controls
}

const rooms = new Map<string, Room>()

// --- persistence: per-room Y.Doc snapshot on disk (survives server restart) ---
const DATA_DIR = pathJoin(process.cwd(), '.data')
mkdirSync(DATA_DIR, { recursive: true })
const roomFile = (name: string) => {
	const enc = encodeURIComponent(name)
	// keep filenames < 255 bytes: long names (e.g. many CJK chars, each 9 bytes) fall back to a hash
	const base = enc.length > 120 ? enc.slice(0, 100) + '-' + createHash('sha1').update(name).digest('hex').slice(0, 12) : enc
	return pathJoin(DATA_DIR, (base || 'default') + '.bin')
}
const saveTimers = new Map<string, NodeJS.Timeout>()

function loadSnapshot(name: string, doc: Y.Doc) {
	const f = roomFile(name)
	if (existsSync(f)) {
		try {
			Y.applyUpdate(doc, readFileSync(f), 'persistence')
		} catch (e) {
			console.warn(`[persist] load failed for "${name}":`, (e as Error).message)
		}
	}
}

function saveNow(name: string, doc: Y.Doc) {
	clearTimeout(saveTimers.get(name))
	saveTimers.delete(name)
	try {
		writeFileSync(roomFile(name), Y.encodeStateAsUpdate(doc))
	} catch (e) {
		console.warn(`[persist] save failed for "${name}":`, (e as Error).message)
	}
}

function scheduleSave(name: string, doc: Y.Doc) {
	clearTimeout(saveTimers.get(name))
	saveTimers.set(name, setTimeout(() => saveNow(name, doc), 500))
}

function flushAll() {
	for (const [name, r] of rooms) saveNow(name, r.doc)
}

// --- per-room serialization: same-room agent/voice runs queue instead of racing
// (fixes Mori-cursor fights, startN overlap, and duplicate-topic snapshots) ---
const roomLocks = new Map<string, Promise<unknown>>()
function withRoomLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const prev = roomLocks.get(name) ?? Promise.resolve()
	const next = prev.then(fn, fn) // run fn whether or not the previous run succeeded
	const guard = next.catch(() => {})
	roomLocks.set(name, guard)
	guard.then(() => {
		if (roomLocks.get(name) === guard) roomLocks.delete(name)
	})
	return next
}

function send(conn: WebSocket, data: Uint8Array) {
	if (conn.readyState !== conn.OPEN && conn.readyState !== conn.CONNECTING) return
	try {
		conn.send(data)
	} catch {
		try {
			conn.close()
		} catch {}
	}
}

function broadcast(room: Room, data: Uint8Array) {
	room.conns.forEach((_ids, conn) => send(conn, data))
}

function getRoom(name: string): Room {
	let room = rooms.get(name)
	if (room) return room

	const doc = new Y.Doc()
	loadSnapshot(name, doc) // restore persisted board, if any
	const awareness = new awarenessProtocol.Awareness(doc)
	const r: Room = { doc, awareness, conns: new Map() }

	// Any doc change (from a client OR the server-side bot) → broadcast + persist.
	doc.on('update', (update: Uint8Array, origin: unknown) => {
		const enc = encoding.createEncoder()
		encoding.writeVarUint(enc, messageSync)
		syncProtocol.writeUpdate(enc, update)
		broadcast(r, encoding.toUint8Array(enc))
		if (origin !== 'persistence') scheduleSave(name, doc)
	})

	awareness.on('update', (
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown
	) => {
		const changed = added.concat(updated, removed)
		// track which client ids each connection controls (for cleanup on close)
		if (origin instanceof Object && r.conns.has(origin as WebSocket)) {
			const ids = r.conns.get(origin as WebSocket)!
			added.forEach((id) => ids.add(id))
			removed.forEach((id) => ids.delete(id))
		}
		const enc = encoding.createEncoder()
		encoding.writeVarUint(enc, messageAwareness)
		encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
		broadcast(r, encoding.toUint8Array(enc))
	})

	rooms.set(name, r)
	return r
}

function onConnection(conn: WebSocket, req: { url?: string }) {
	conn.binaryType = 'arraybuffer'
	// Decode the room name so the WS path matches express's auto-decoded :room
	// param (otherwise "spike,畫一張" splits into two rooms — the client watches
	// the %-encoded one while /api/agent writes the decoded one).
	let path = (req.url || '/').slice(1).split('?')[0]
	if (path.startsWith('sync/')) path = path.slice(5) // strip the Vite-proxy prefix
	let roomName = path || 'default'
	try {
		roomName = decodeURIComponent(roomName)
	} catch {}
	const room = getRoom(roomName)
	room.conns.set(conn, new Set())
	console.log(`[sync] client joined "${roomName}" (${room.conns.size} online)`)

	conn.on('message', (message: ArrayBuffer | Buffer) => {
		try {
			const u8 =
				message instanceof ArrayBuffer
					? new Uint8Array(message)
					: new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
			const decoder = decoding.createDecoder(u8)
			const messageType = decoding.readVarUint(decoder)
			if (messageType === messageSync) {
				const encoder = encoding.createEncoder()
				encoding.writeVarUint(encoder, messageSync)
				syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn)
				if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
			} else if (messageType === messageAwareness) {
				awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn)
			}
		} catch (e) {
			console.error('[sync] message error', e)
		}
	})

	conn.on('close', () => {
		const ids = room.conns.get(conn)
		room.conns.delete(conn)
		if (ids && ids.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null)
		console.log(`[sync] client left "${roomName}" (${room.conns.size} online)`)
	})

	// 1) send our state vector so the client can reply with what we're missing
	const encoder = encoding.createEncoder()
	encoding.writeVarUint(encoder, messageSync)
	syncProtocol.writeSyncStep1(encoder, room.doc)
	send(conn, encoding.toUint8Array(encoder))

	// 2) send current awareness states to the newcomer
	const states = room.awareness.getStates()
	if (states.size) {
		const enc = encoding.createEncoder()
		encoding.writeVarUint(enc, messageAwareness)
		encoding.writeVarUint8Array(
			enc,
			awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()])
		)
		send(conn, encoding.toUint8Array(enc))
	}
}

const rid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`

// auto-layout: cards live in columns by kind (主題/待辦/決議/風險). A new card drops
// to the bottom of its kind's column, so the board stays tidy as it keeps growing.
const COL_ORDER = ['yellow', 'green', 'blue', 'red']
const CARD_W = 200
const CARD_H = 200
const COL_GAP = 50
const ROW_GAP = 36
const X0 = 120
const Y0 = 120
const columnOf = (color: string) => {
	const i = COL_ORDER.indexOf(color)
	return i < 0 ? COL_ORDER.length : i
}
const slotXY = (col: number, row: number) => ({ x: X0 + col * (CARD_W + COL_GAP), y: Y0 + row * (CARD_H + ROW_GAP) })
function nextRowInColumn(shapes: Y.Map<any>, col: number): number {
	let n = 0
	for (const s of shapes.values()) if ((s as any).type === 'sticky' && columnOf((s as any).color) === col) n++
	return n
}

/** Place one sticky into its kind-column (auto-layout). Returns its id. */
function placeSticky(room: Room, text: string, color: string, drawnBy: string): string {
	const shapes = room.doc.getMap('shapes')
	const id = rid('sticky')
	const col = columnOf(color)
	const { x, y } = slotXY(col, nextRowInColumn(shapes, col))
	shapes.set(id, { id, type: 'sticky', x, y, w: CARD_W, h: CARD_H, text, color, drawnBy })
	return id
}

/** THE BOT: a server-side write into the shared room. Plain yjs, no editor. */
function drawSticky(roomName: string, text: string, color = 'yellow'): string {
	const room = getRoom(roomName)
	let id = ''
	room.doc.transact(() => {
		id = placeSticky(room, text, color, 'bot')
	})
	console.log(`[bot] drew sticky in "${roomName}": ${id} — "${text}"`)
	return id
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Publish (or clear) "Mori"'s live cursor on a room via awareness, so every client sees it. */
function setMoriCursor(room: Room, cursor: { x: number; y: number } | null) {
	room.awareness.setLocalState(cursor ? { user: { name: 'Mori', color: '#7c3aed' }, cursor } : null)
}

/** Existing stickies in a STABLE order (by id) — the same order fed to the agent. */
function existingStickies(room: Room): ExistingCard[] {
	return [...room.doc.getMap('shapes').values()]
		.filter((s: any) => s.type === 'sticky')
		.sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
		.map((s: any) => ({ id: s.id, text: s.text, color: s.color, owner: s.owner, tags: s.tags, frameId: s.frameId }))
}

/** Frames (diagrams) on the canvas, in creation order (stable for agent indexing). */
function getFrames(room: Room): { id: string; title: string; type: string }[] {
	return [...room.doc.getMap('frames').values()]
		.sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
		.map((f: any) => ({ id: f.id, title: f.title, type: f.type }))
}

const COLOR_BY_KIND: Record<string, string> = { topic: 'yellow', todo: 'green', decision: 'blue', risk: 'red' }

/**
 * Run a recognised voice command. Board mutations (tidy/assign/recolor) happen
 * here and sync to everyone; view commands (filter/clearFilter) are returned so
 * the client that spoke them can apply them locally. Returns a human label + an
 * optional view command for the client.
 */
function runCommand(room: Room, existing: ExistingCard[], cmd: AgentCommand): { label: string; view?: any } {
	const shapes = room.doc.getMap('shapes')
	switch (cmd.action) {
		case 'tidy':
			tidyBoard(room)
			return { label: '自動排列' }
		case 'filter':
			return { label: `只看 ${cmd.by === 'tag' ? '#' + cmd.value : cmd.value}`, view: { action: 'filter', by: cmd.by, value: cmd.value } }
		case 'clearFilter':
			return { label: '顯示全部', view: { action: 'clearFilter' } }
		case 'assign': {
			const id = existing[cmd.index]?.id
			const cur = id ? (shapes.get(id) as any) : undefined
			if (cur) room.doc.transact(() => shapes.set(id, { ...cur, owner: cmd.owner }))
			return { label: cur ? `指派「${cur.text}」給 ${cmd.owner}` : '指派失敗' }
		}
		case 'recolor': {
			const id = existing[cmd.index]?.id
			const cur = id ? (shapes.get(id) as any) : undefined
			const color = COLOR_BY_KIND[cmd.kind]
			if (cur && color) room.doc.transact(() => shapes.set(id, { ...cur, color }))
			return { label: cur ? `「${cur.text}」改為${KIND_BY_COLOR[color] ?? cmd.kind}` : '改色失敗' }
		}
		case 'tag': {
			const id = existing[cmd.index]?.id
			const cur = id ? (shapes.get(id) as any) : undefined
			if (cur) {
				const merged = [...new Set([...(cur.tags || []), ...cmd.tags])].slice(0, 3)
				room.doc.transact(() => shapes.set(id, { ...cur, tags: merged }))
			}
			return { label: cur ? `「${cur.text}」加上 #${cmd.tags.join(' #')}` : '加標籤失敗' }
		}
		case 'edit': {
			const id = existing[cmd.index]?.id
			const cur = id ? (shapes.get(id) as any) : undefined
			const old = cur?.text
			if (cur) room.doc.transact(() => shapes.set(id, { ...cur, text: cmd.text }))
			return { label: cur ? `「${old}」改寫為「${cmd.text}」` : '改寫失敗' }
		}
	}
}

/**
 * Apply a board plan by ACCUMULATING (merge mode):
 *  - new stickies are appended (grid by total count), existing ones untouched.
 *  - connector indices are in the unified space [existing... , new...]; `existingIds`
 *    is the id list (same order) that was shown to the agent, so we can resolve
 *    a connector endpoint to either an existing sticky or a freshly-created one.
 */
async function applyPlan(
	roomName: string,
	plan: BoardPlan,
	drawnBy: string,
	existingIds: string[],
	frameId?: string
): Promise<{ ids: string[]; connectorsDrawn: number }> {
	const room = getRoom(roomName)
	const shapes = room.doc.getMap('shapes')
	const connectors = room.doc.getMap('connectors')
	const newIds: string[] = []
	const E = existingIds.length
	let drawn = 0
	try {
		// First apply edits/removals the agent decided on (e.g. a decision was
		// overturned, a todo got done) — keeps a long meeting board from only growing.
		if (plan.updates?.length || plan.deletes?.length) {
			room.doc.transact(() => {
				for (const u of plan.updates || []) {
					const id = existingIds[u.index]
					const cur = id ? (shapes.get(id) as any) : undefined
					if (cur) {
						shapes.set(id, {
							...cur,
							...(u.text !== undefined ? { text: u.text } : {}),
							...(u.color !== undefined ? { color: u.color } : {}),
						})
					}
				}
				for (const idx of plan.deletes || []) {
					const id = existingIds[idx]
					if (id && shapes.has(id)) {
						shapes.delete(id)
						for (const [cid, c] of connectors) if ((c as any).from === id || (c as any).to === id) connectors.delete(cid)
					}
				}
			})
			if (plan.updates?.length || plan.deletes?.length)
				console.log(`[agent] ~${plan.updates?.length || 0} updates, -${plan.deletes?.length || 0} deletes in "${roomName}"`)
		}

		// Stream the stickies in one-by-one into their kind-column (auto-layout),
		// moving Mori's live cursor to each. Column row is read from the LIVE board
		// inside the transact, so concurrent writes can't collide.
		for (const s of plan.stickies) {
			const id = rid('sticky')
			let cx = 0
			let cy = 0
			room.doc.transact(() => {
				const col = columnOf(s.color)
				const { x, y } = slotXY(col, nextRowInColumn(shapes, col))
				cx = x + CARD_W / 2
				cy = y + CARD_H / 2
				shapes.set(id, {
					id,
					type: 'sticky',
					x,
					y,
					w: CARD_W,
					h: CARD_H,
					text: s.text,
					color: s.color,
					drawnBy,
					...(frameId ? { frameId } : {}),
					...(s.owner ? { owner: s.owner } : {}),
					...(s.tags && s.tags.length ? { tags: s.tags } : {}),
				})
			})
			newIds.push(id)
			setMoriCursor(room, { x: cx, y: cy })
			await sleep(260)
		}

		room.doc.transact(() => {
			const resolve = (idx: number): string | undefined => (idx < E ? existingIds[idx] : newIds[idx - E])
			for (const [a, b] of plan.connectors) {
				const from = resolve(a)
				const to = resolve(b)
				if (from && to && from !== to && shapes.has(from) && shapes.has(to)) {
					const cid = rid('conn')
					connectors.set(cid, { id: cid, from, to })
					drawn++
				} else {
					console.warn(`[agent] skip connector ${a}->${b}: endpoint sticky missing (deleted mid-stream?)`)
				}
			}
		})
		await sleep(300)
		console.log(`[agent] +${newIds.length} stickies, +${drawn}/${plan.connectors.length} connectors in "${roomName}"`)
		return { ids: newIds, connectorsDrawn: drawn }
	} finally {
		setMoriCursor(room, null) // Mori always leaves the board, even on error
	}
}

// Optional hardening via env (defaults keep localhost dev frictionless):
//   WB_API_KEY       — if set, /api/* (except health) requires header X-API-Key
//   ALLOWED_ORIGINS  — comma-list; if set, CORS only echoes matching origins (else '*')
//   HOST             — bind address (default 127.0.0.1 loopback; set 0.0.0.0 for LAN)
const API_KEY = process.env.WB_API_KEY || ''
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
const HOST = process.env.HOST || '127.0.0.1'

const app = express()
app.use(express.json())
app.use((req, res, next) => {
	const origin = req.headers.origin
	if (ALLOWED.length === 0) res.setHeader('Access-Control-Allow-Origin', '*')
	else if (origin && ALLOWED.includes(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin)
		res.setHeader('Vary', 'Origin')
	}
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key')
	if (req.method === 'OPTIONS') {
		res.sendStatus(204)
		return
	}
	next()
})
// opt-in API key gate (health stays open for probes)
app.use('/api', (req, res, next) => {
	if (!API_KEY || req.path === '/health') return next()
	if (req.header('X-API-Key') === API_KEY) return next()
	res.status(401).json({ ok: false, error: 'unauthorized' })
})

// simple per-IP rate limit for the expensive endpoints (guards Groq/STT abuse)
const RL_MAX = Number(process.env.RATE_MAX || 30) // requests / minute / IP
const rlHits = new Map<string, number[]>()
function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
	const ip = req.ip || req.socket.remoteAddress || 'x'
	const now = Date.now()
	const arr = (rlHits.get(ip) || []).filter((t) => now - t < 60_000)
	if (arr.length >= RL_MAX) {
		res.status(429).json({ ok: false, error: '太頻繁,請稍候再試' })
		return
	}
	arr.push(now)
	rlHits.set(ip, arr)
	next()
}

app.post('/api/bot/:room/sticky', (req, res) => {
	const { room } = req.params
	const text: string = req.body?.text ?? `bot @ ${new Date().toLocaleTimeString()}`
	const color: string = req.body?.color ?? 'yellow'
	const id = drawSticky(room, text, color)
	res.json({ ok: true, room, id, text, color })
})

// Agent: transcript -> board plan (Groq->Ollama) -> stickies + connectors.
// Wrapped in a per-room lock so concurrent runs queue instead of racing.
// One agent turn: classify intent, then either run the command or apply content.
async function runAgentTurn(roomName: string, transcript: string, by: string): Promise<any> {
	return withRoomLock(roomName, async () => {
		const room = getRoom(roomName)
		const meta = boardMeta(room)
		const existing = existingStickies(room)
		const frames = getFrames(room)
		const { result, provider } = await planAgent(transcript, existing, meta.topic, frames)
		if (result.intent === 'command') {
			const done = runCommand(room, existing, result.command)
			console.log(`[agent] command in "${roomName}": ${done.label}`)
			return { provider, intent: 'command', command: done.view ?? null, commandLabel: done.label, added: [], stickies: 0, connectors: 0 }
		}
		// resolve which diagram (frame) this content belongs to; create one if the agent asked
		let frameId: string | undefined
		let frameLabel = ''
		const fr = result.plan.frame
		if (fr?.newType) {
			const f = createFrame(room, fr.newType, fr.newTitle || '')
			frameId = f.id
			frameLabel = `開新圖:${boardType(f.type).label}「${f.title}」`
		} else if (fr?.index != null && frames[fr.index]) {
			frameId = frames[fr.index].id
		} else if (frames.length) {
			frameId = frames[0].id
		} else {
			const f = createFrame(room, meta.type, meta.topic || boardType(meta.type).label)
			frameId = f.id
			frameLabel = `開新圖:${boardType(f.type).label}`
		}
		const r = await applyPlan(roomName, result.plan, by, existing.map((e) => e.id), frameId)
		if (SETTINGS.autoTidy && (r.ids.length || r.connectorsDrawn)) tidyBoard(room) // re-flow every frame into its layout
		return { provider, intent: 'content', added: result.plan.stickies, ids: r.ids, stickies: r.ids.length, connectors: r.connectorsDrawn, frameLabel }
	})
}

app.post('/api/agent/:room', rateLimit, async (req, res) => {
	const transcript = String(req.body?.transcript ?? '').trim()
	if (!transcript) {
		res.status(400).json({ ok: false, error: 'transcript required' })
		return
	}
	try {
		const by = (String(req.body?.by ?? '').trim() || 'agent').slice(0, 24)
		const out = await runAgentTurn(req.params.room, transcript, by)
		res.json({ ok: true, ...out })
	} catch (e) {
		console.error('[agent] error', e)
		res.status(500).json({ ok: false, error: (e as Error).message })
	}
})

// Voice: raw audio bytes -> mori-ear STT -> agent -> board. Full chain.
app.post('/api/voice/:room', rateLimit, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
	const ext = String(req.query.ext ?? 'webm').replace(/[^a-z0-9]/gi, '') || 'webm'
	const tmp = pathJoin(tmpdir(), `voice-${rid('a')}.${ext}`)
	try {
		await writeFile(tmp, req.body as Buffer)
		const transcript = await transcribe(tmp) // STT outside the lock (room-independent)
		if (!transcript) {
			res.json({ ok: true, transcript: '', stickies: 0, note: 'empty transcript' })
			return
		}
		const by = (String(req.query.by ?? '').trim() || 'voice').slice(0, 24)
		const out = await runAgentTurn(req.params.room, transcript, by)
		res.json({ ok: true, transcript, ...out })
	} catch (e) {
		console.error('[voice] error', e)
		res.status(500).json({ ok: false, error: (e as Error).message })
	} finally {
		unlink(tmp).catch(() => {})
	}
})

// Transcribe-only: audio -> text (no agent, no board). For dictating a single card.
app.post('/api/transcribe', rateLimit, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
	const ext = String(req.query.ext ?? 'webm').replace(/[^a-z0-9]/gi, '') || 'webm'
	const tmp = pathJoin(tmpdir(), `t-${rid('a')}.${ext}`)
	try {
		await writeFile(tmp, req.body as Buffer)
		const text = await transcribe(tmp)
		res.json({ ok: true, text })
	} catch (e) {
		res.status(500).json({ ok: false, error: (e as Error).message })
	} finally {
		unlink(tmp).catch(() => {})
	}
})

// Per-card voice edit: audio -> STT -> LLM understands which fields to change
// (text / tags / owner / kind) and patches THAT card.
app.post('/api/card/:room/:cardId', rateLimit, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
	const ext = String(req.query.ext ?? 'webm').replace(/[^a-z0-9]/gi, '') || 'webm'
	const tmp = pathJoin(tmpdir(), `c-${rid('a')}.${ext}`)
	try {
		await writeFile(tmp, req.body as Buffer)
		const transcript = await transcribe(tmp)
		const room = getRoom(req.params.room)
		const shapes = room.doc.getMap('shapes')
		const cur = shapes.get(req.params.cardId) as any
		if (!cur) {
			res.status(404).json({ ok: false, error: 'card not found', transcript })
			return
		}
		if (!transcript) {
			res.json({ ok: true, transcript: '', edit: {} })
			return
		}
		const { edit, provider } = await planCardEdit(transcript, { text: cur.text, tags: cur.tags, owner: cur.owner, color: cur.color })
		if (Object.keys(edit).length) room.doc.transact(() => shapes.set(req.params.cardId, { ...cur, ...edit }))
		res.json({ ok: true, transcript, edit, provider })
	} catch (e) {
		res.status(500).json({ ok: false, error: (e as Error).message })
	} finally {
		unlink(tmp).catch(() => {})
	}
})

// Export the board as a Markdown meeting note (kind = sticky colour).
const KIND_BY_COLOR: Record<string, string> = { yellow: '主題', green: '待辦', blue: '決議', red: '風險' }
app.get('/api/export/:room', (req, res) => {
	const room = getRoom(req.params.room)
	const doc = room.doc
	const shapes = [...doc.getMap('shapes').values()].filter((s: any) => s.type === 'sticky') as any[]
	const conns = [...doc.getMap('connectors').values()] as any[]
	const meta = boardMeta(room)
	const frames = getFrames(room)
	const named = (s: any) => (s.owner ? `(${s.owner})` : s.drawnBy && !['user', 'agent', 'voice', 'bot'].includes(s.drawnBy) ? `(${s.drawnBy})` : '')
	const tagstr = (s: any) => (s.tags?.length ? ' ' + s.tags.map((t: string) => `#${t}`).join(' ') : '')
	const txt = (id: string) => shapes.find((s) => s.id === id)?.text ?? '?'
	const order = ['blue', 'green', 'yellow', 'red']
	// render one diagram's cards grouped by its type's colour meanings + its edges
	const section = (heading: string, typeKey: string, cards: any[], hLevel: string) => {
		const bt = boardType(typeKey)
		const byCat: Record<string, string[]> = {}
		for (const s of cards) (byCat[bt.colors[s.color] || '其他'] ??= []).push(`- ${s.text}${named(s)}${tagstr(s)}`)
		let out = `${hLevel} ${heading}\n`
		for (const cat of [...order.map((c) => bt.colors[c]).filter(Boolean), '其他'])
			if (byCat[cat]?.length) out += `\n**${cat}**\n${byCat[cat].join('\n')}\n`
		const ids = new Set(cards.map((c) => c.id))
		const edges = conns.filter((c) => ids.has(c.from) && ids.has(c.to))
		if (edges.length) out += `\n**${bt.edgeLabel}**\n${edges.map((c) => `- ${txt(c.from)} → ${txt(c.to)}`).join('\n')}\n`
		return out + '\n'
	}
	let md = ''
	if (frames.length) {
		md = `# 會議白板:${meta.topic || req.params.room}\n\n`
		for (const f of frames) md += section(`${boardType(f.type).label}:${f.title}`, f.type, shapes.filter((s) => s.frameId === f.id), '##')
		const loose = shapes.filter((s) => !s.frameId || !frames.some((f) => f.id === s.frameId))
		if (loose.length) md += section('其他便利貼', meta.type, loose, '##')
		const xref = conns.filter((c) => {
			const a = shapes.find((s) => s.id === c.from)
			const b = shapes.find((s) => s.id === c.to)
			return a && b && a.frameId && b.frameId && a.frameId !== b.frameId
		})
		if (xref.length) md += `## 跨圖關聯\n${xref.map((c) => `- ${txt(c.from)} → ${txt(c.to)}`).join('\n')}\n`
	} else {
		// single-diagram board (no frames)
		md = section(`${boardType(meta.type).label}:${meta.topic || req.params.room}`, meta.type, shapes, '#')
	}
	res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
	res.send(md)
})

// The host's LAN IPv4 — so the client builds a share/QR URL others can actually
// reach (localhost on a phone is the phone itself, not this machine).
function lanIp(): string | null {
	const addrs: string[] = []
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address)
	}
	return (
		addrs.find((a) => a.startsWith('192.168.')) ||
		addrs.find((a) => a.startsWith('10.')) ||
		addrs.find((a) => !a.startsWith('172.1')) || // skip docker bridges 172.17/172.18
		addrs[0] ||
		null
	)
}
app.get('/api/lan', (_req, res) => res.json({ ip: lanIp() }))

// End-of-meeting: turn the board into a proper one-page meeting note (via the LLM).
app.get('/api/summary/:room', async (req, res) => {
	try {
		const doc = getRoom(req.params.room).doc
		const shapes = [...doc.getMap('shapes').values()].filter((s: any) => s.type === 'sticky') as any[]
		const conns = [...doc.getMap('connectors').values()] as any[]
		res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
		if (!shapes.length) {
			res.send(`# 會議摘要:${req.params.room}\n\n(白板還沒有內容)\n`)
			return
		}
		const named = (s: any) => (s.drawnBy && !['user', 'agent', 'voice', 'bot'].includes(s.drawnBy) ? `(${s.drawnBy})` : '')
		const lines = shapes.map((s) => `- [${KIND_BY_COLOR[s.color] || '其他'}] ${s.text}${named(s)}`)
		const rel = conns
			.map((c) => {
				const f = shapes.find((s) => s.id === c.from)?.text
				const t = shapes.find((s) => s.id === c.to)?.text
				return f && t ? `- ${f} → ${t}` : null
			})
			.filter(Boolean)
		const board = `便利貼(括號內是提出者):\n${lines.join('\n')}\n\n關聯:\n${rel.join('\n') || '(無)'}`
		const { text } = await chat([
			{
				role: 'system',
				content:
					'你是會議記錄員。根據提供的白板便利貼(已分類)整理成一頁繁體中文會議紀錄,用這些區塊:## 會議重點 / ## 決議 / ## 待辦事項(若便利貼標了提出者,在待辦後標負責人)/ ## 風險 / ## 下一步。只根據提供內容,不得編造;沒有內容的區塊就省略。直接輸出 markdown,不要前言。',
			},
			{ role: 'user', content: board },
		])
		const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
		res.send(`# 會議摘要:${req.params.room}\n\n${clean}\n`)
	} catch (e) {
		res.status(500).send('摘要失敗:' + (e as Error).message)
	}
})

// Active rooms (in memory) with live counts — for the room manager.
app.get('/api/rooms', (_req, res) => {
	const list = [...rooms.entries()]
		.map(([id, r]) => ({ id, shapes: r.doc.getMap('shapes').size, online: r.conns.size }))
		.sort((a, b) => b.online - a.online || b.shapes - a.shapes)
	res.json({ rooms: list })
})

// End a room: clear the board for everyone + drop its snapshot.
app.post('/api/rooms/:room/end', (req, res) => {
	const name = req.params.room
	clearTimeout(saveTimers.get(name))
	saveTimers.delete(name)
	const r = rooms.get(name)
	if (r) {
		r.doc.transact(() => {
			r.doc.getMap('shapes').clear()
			r.doc.getMap('connectors').clear()
		})
	}
	try {
		if (existsSync(roomFile(name))) unlinkSync(roomFile(name))
	} catch {}
	res.json({ ok: true })
})

// Auto-arrange: re-lay every sticky into its kind-column, top-to-bottom (one-tap tidy).
function boardMeta(room: Room): { type: string; topic: string } {
	const m = room.doc.getMap('meta')
	const type = typeof m.get('type') === 'string' ? (m.get('type') as string) : DEFAULT_BOARD_TYPE
	const topic = typeof m.get('topic') === 'string' ? (m.get('topic') as string) : ''
	return { type, topic }
}

// ---- pure layout positioners: given a frame's cards (+ connectors), return
// id -> {x,y} relative to an origin (ox,oy). No mutation — relayout() applies them. ----
type Pos = Map<string, { x: number; y: number }>
const W = CARD_W
const H = CARD_H

function colPositions(cards: any[], ox: number, oy: number): Pos {
	const pos: Pos = new Map()
	const rowByCol: Record<number, number> = {}
	for (const s of [...cards].sort((a, b) => columnOf(a.color) - columnOf(b.color) || a.y - b.y || a.x - b.x)) {
		const col = columnOf(s.color)
		const row = rowByCol[col] ?? 0
		rowByCol[col] = row + 1
		pos.set(s.id, { x: ox + col * (W + COL_GAP * sp()), y: oy + row * (H + ROW_GAP * sp()) })
	}
	return pos
}

// shared graph builder for tree/radial
function buildGraph(cards: any[], conns: any[]) {
	const ids = cards.map((c) => c.id)
	const idset = new Set(ids)
	const children = new Map<string, string[]>()
	const indeg = new Map<string, number>()
	ids.forEach((id) => {
		children.set(id, [])
		indeg.set(id, 0)
	})
	for (const c of conns) {
		if (idset.has(c.from) && idset.has(c.to) && c.from !== c.to) {
			children.get(c.from)!.push(c.to)
			indeg.set(c.to, (indeg.get(c.to) || 0) + 1)
		}
	}
	return { ids, children, indeg }
}

function treePositions(cards: any[], conns: any[], ox: number, oy: number, dir: 'TB' | 'LR'): Pos {
	const pos: Pos = new Map()
	if (!cards.length) return pos
	const byId = new Map(cards.map((c) => [c.id, c]))
	const { ids, children, indeg } = buildGraph(cards, conns)
	let roots = ids.filter((id) => (indeg.get(id) || 0) === 0)
	if (!roots.length) roots = [ids[0]]
	const level = new Map<string, number>()
	const queue: [string, number][] = roots.map((r) => [r, 0])
	let guard = 0
	while (queue.length && guard++ < 20000) {
		const [id, lv] = queue.shift()!
		if ((level.get(id) ?? -1) >= lv) continue
		level.set(id, lv)
		for (const ch of children.get(id) || []) queue.push([ch, lv + 1])
	}
	ids.forEach((id) => {
		if (!level.has(id)) level.set(id, 0)
	})
	const order = [...ids].sort(
		(a, b) => level.get(a)! - level.get(b)! || (dir === 'LR' ? byId.get(a).y - byId.get(b).y : byId.get(a).x - byId.get(b).x)
	)
	const byLevel = new Map<number, string[]>()
	for (const id of order) {
		const lv = level.get(id)!
		if (!byLevel.has(lv)) byLevel.set(lv, [])
		byLevel.get(lv)!.push(id)
	}
	const GX = W + 50 * sp()
	const GY = H + 40 * sp()
	for (const [lv, list] of byLevel)
		list.forEach((id, i) => {
			pos.set(id, dir === 'LR' ? { x: ox + lv * GX, y: oy + i * GY } : { x: ox + i * GX, y: oy + lv * GY })
		})
	return pos
}

function radialPositions(cards: any[], conns: any[], ox: number, oy: number): Pos {
	const pos: Pos = new Map()
	if (!cards.length) return pos
	const { ids, children, indeg } = buildGraph(cards, conns)
	const roots = ids.filter((id) => (indeg.get(id) || 0) === 0)
	const center = roots[0] || ids[0]
	const level = new Map<string, number>([[center, 0]])
	const q: [string, number][] = [[center, 0]]
	let guard = 0
	while (q.length && guard++ < 20000) {
		const [id, lv] = q.shift()!
		for (const ch of children.get(id) || [])
			if (!level.has(ch)) {
				level.set(ch, lv + 1)
				q.push([ch, lv + 1])
			}
	}
	ids.forEach((id) => {
		if (!level.has(id)) level.set(id, 1)
	})
	const leaves = new Map<string, number>()
	const countLeaves = (id: string, seen = new Set<string>()): number => {
		if (seen.has(id)) return 1
		seen.add(id)
		const ch = (children.get(id) || []).filter((k) => (level.get(k) || 0) > (level.get(id) || 0))
		const c = ch.length ? ch.reduce((s, k) => s + countLeaves(k, seen), 0) : 1
		leaves.set(id, c)
		return c
	}
	countLeaves(center)
	const ang = new Map<string, number>()
	const assign = (id: string, a0: number, a1: number, seen = new Set<string>()) => {
		if (seen.has(id)) return
		seen.add(id)
		ang.set(id, (a0 + a1) / 2)
		const ch = (children.get(id) || []).filter((k) => (level.get(k) || 0) > (level.get(id) || 0) && !seen.has(k))
		const total = ch.reduce((s, k) => s + (leaves.get(k) || 1), 0) || 1
		let a = a0
		for (const k of ch) {
			const span = (a1 - a0) * ((leaves.get(k) || 1) / total)
			assign(k, a, a + span, seen)
			a += span
		}
	}
	assign(center, -Math.PI / 2, (3 * Math.PI) / 2)
	const RING = 200 + 40 * sp()
	const maxLv = Math.max(0, ...[...level.values()])
	const cx = ox + RING * maxLv
	const cy = oy + RING * maxLv
	for (const id of ids) {
		const lv = level.get(id)!
		if (lv === 0) pos.set(id, { x: cx, y: cy })
		else pos.set(id, { x: cx + RING * lv * Math.cos(ang.get(id) ?? 0), y: cy + RING * lv * Math.sin(ang.get(id) ?? 0) })
	}
	return pos
}

function quadrantPositions(cards: any[], ox: number, oy: number): Pos {
	const pos: Pos = new Map()
	const g: Record<string, any[]> = { green: [], yellow: [], blue: [], red: [] }
	for (const s of cards) (g[s.color] || g.green).push(s)
	const GY = 24 * sp()
	const topRows = Math.max(g.green.length, g.yellow.length)
	const botY = oy + topRows * (H + GY) + 80
	const leftX = ox
	const rightX = ox + W + 80 * sp()
	const place = (arr: any[], x: number, y0: number) => arr.forEach((s, i) => pos.set(s.id, { x, y: y0 + i * (H + GY) }))
	place(g.green, leftX, oy)
	place(g.yellow, rightX, oy)
	place(g.blue, leftX, botY)
	place(g.red, rightX, botY)
	return pos
}

// fishbone: problem at the right "head", causes branch off the spine above/below
function fishbonePositions(cards: any[], conns: any[], ox: number, oy: number): Pos {
	const pos: Pos = new Map()
	if (!cards.length) return pos
	const { ids, children } = buildGraph(cards, conns)
	let head = ids.find((id) => (children.get(id) || []).length === 0) || ids[0]
	const parents = new Map<string, string[]>(ids.map((id) => [id, []]))
	for (const f of ids) for (const t of children.get(f) || []) parents.get(t)!.push(f)
	const level = new Map<string, number>([[head, 0]])
	const q: [string, number][] = [[head, 0]]
	let g = 0
	while (q.length && g++ < 20000) {
		const [id, lv] = q.shift()!
		for (const p of parents.get(id) || [])
			if (!level.has(p)) {
				level.set(p, lv + 1)
				q.push([p, lv + 1])
			}
	}
	ids.forEach((id) => {
		if (!level.has(id)) level.set(id, 1)
	})
	const byLevel = new Map<number, string[]>()
	for (const id of ids) {
		const lv = level.get(id)!
		if (!byLevel.has(lv)) byLevel.set(lv, [])
		byLevel.get(lv)!.push(id)
	}
	const maxLv = Math.max(...[...level.values()])
	const GX = W + 50 * sp()
	const GY = H + 30 * sp()
	let maxOff = 1
	for (const [lv, list] of byLevel) if (lv > 0) maxOff = Math.max(maxOff, Math.ceil(list.length / 2))
	const spineY = oy + maxOff * GY
	for (const [lv, list] of byLevel) {
		if (lv === 0) {
			pos.set(list[0], { x: ox + maxLv * GX, y: spineY })
			continue
		}
		list.forEach((id, i) => {
			const above = i % 2 === 0
			const yOff = (Math.floor(i / 2) + 1) * GY * (above ? -1 : 1)
			pos.set(id, { x: ox + (maxLv - lv) * GX, y: spineY + yOff })
		})
	}
	return pos
}

// gantt / schedule: columns = time order (topological), rows = owner swimlanes
function ganttPositions(cards: any[], conns: any[], ox: number, oy: number): Pos {
	const pos: Pos = new Map()
	if (!cards.length) return pos
	const byId = new Map(cards.map((c) => [c.id, c]))
	const { ids, children, indeg } = buildGraph(cards, conns)
	const indegC = new Map(ids.map((id) => [id, indeg.get(id) || 0]))
	const queue = ids.filter((id) => (indegC.get(id) || 0) === 0).sort((a, b) => byId.get(a).x - byId.get(b).x)
	const order: string[] = []
	const seen = new Set<string>()
	let g = 0
	while (queue.length && g++ < 20000) {
		const id = queue.shift()!
		if (seen.has(id)) continue
		seen.add(id)
		order.push(id)
		for (const t of children.get(id) || []) {
			indegC.set(t, (indegC.get(t) || 0) - 1)
			if ((indegC.get(t) || 0) <= 0) queue.push(t)
		}
	}
	for (const id of ids) if (!seen.has(id)) order.push(id)
	const rowOf = new Map<string, number>()
	for (const id of order) {
		const o = byId.get(id).owner || '未指派'
		if (!rowOf.has(o)) rowOf.set(o, rowOf.size)
	}
	const GX = W + 40 * sp()
	const GY = H + 30 * sp()
	order.forEach((id, col) => {
		const o = byId.get(id).owner || '未指派'
		pos.set(id, { x: ox + col * GX, y: oy + (rowOf.get(o) || 0) * GY })
	})
	return pos
}

function layoutPositions(typeKey: string, cards: any[], conns: any[], ox: number, oy: number): Pos {
	const bt = boardType(typeKey)
	if (bt.layout === 'tree') return treePositions(cards, conns, ox, oy, bt.dir)
	if (bt.layout === 'radial') return radialPositions(cards, conns, ox, oy)
	if (bt.layout === 'quadrant') return quadrantPositions(cards, ox, oy)
	if (bt.layout === 'fishbone') return fishbonePositions(cards, conns, ox, oy)
	if (bt.layout === 'gantt') return ganttPositions(cards, conns, ox, oy)
	return colPositions(cards, ox, oy)
}

const FRAME_PAD = 28
const FRAME_HEAD = 60 // room for the frame title bar

// Lay out every frame's cards within that frame, and resize each frame to fit.
// Frameless boards (legacy / single-diagram) fall back to one whole-board layout.
function tidyBoard(room: Room) {
	const shapes = room.doc.getMap('shapes')
	const frames = room.doc.getMap('frames')
	const conns = [...room.doc.getMap('connectors').values()] as any[]
	const allCards = [...shapes.values()].filter((s: any) => s.type === 'sticky') as any[]
	const frameList = [...frames.values()] as any[]
	room.doc.transact(() => {
		if (!frameList.length) {
			const pos = layoutPositions(boardMeta(room).type, allCards, conns, X0, Y0)
			for (const [id, p] of pos) {
				const cur = shapes.get(id) as any
				if (cur) shapes.set(id, { ...cur, ...p })
			}
			return
		}
		for (const f of frameList) {
			const cards = allCards.filter((s) => s.frameId === f.id)
			if (!cards.length) continue
			const pos = layoutPositions(f.type, cards, conns, f.x + FRAME_PAD, f.y + FRAME_HEAD)
			let maxX = f.x
			let maxY = f.y
			for (const [id, p] of pos) {
				const cur = shapes.get(id) as any
				if (!cur) continue
				shapes.set(id, { ...cur, x: p.x, y: p.y })
				maxX = Math.max(maxX, p.x + (cur.w || W))
				maxY = Math.max(maxY, p.y + (cur.h || H))
			}
			frames.set(f.id, { ...f, w: Math.max(440, maxX - f.x + FRAME_PAD), h: Math.max(300, maxY - f.y + FRAME_PAD) })
		}
	})
}

// place a brand-new frame to the right of existing ones (so they don't overlap)
function createFrame(room: Room, type: string, title: string): any {
	const frames = room.doc.getMap('frames')
	const list = [...frames.values()] as any[]
	let x = 80
	let y = 80
	if (list.length) {
		const right = list.reduce((a, b) => (a.x + a.w > b.x + b.w ? a : b))
		x = right.x + right.w + 90
		y = right.y
	}
	const id = rid('frame')
	const f = { id, title: title || boardType(type).label, type, x, y, w: 480, h: 320 }
	room.doc.transact(() => frames.set(id, f))
	return f
}
app.post('/api/rooms/:room/tidy', (req, res) => {
	tidyBoard(getRoom(req.params.room))
	res.json({ ok: true })
})

// board type/topic metadata — drives how the agent interprets and how it auto-arranges
app.get('/api/rooms/:room/meta', (req, res) => {
	res.json({
		ok: true,
		...boardMeta(getRoom(req.params.room)),
		types: Object.values(BOARD_TYPES).map((t) => ({ key: t.key, label: t.label, blurb: t.blurb })),
	})
})
app.post('/api/rooms/:room/meta', (req, res) => {
	const room = getRoom(req.params.room)
	const m = room.doc.getMap('meta')
	const type = String(req.body?.type ?? '')
	room.doc.transact(() => {
		if (BOARD_TYPES[type]) m.set('type', type)
		if (req.body?.topic !== undefined) m.set('topic', String(req.body.topic).slice(0, 80))
	})
	res.json({ ok: true, ...boardMeta(room) })
})

// page settings: AI processing (cloud/local) + auto-arrange tuning (not hardcoded)
app.get('/api/settings', (_req, res) => res.json({ ok: true, ...llmStatus(), spacing: SETTINGS.spacing, autoTidy: SETTINGS.autoTidy }))
app.post('/api/settings', (req, res) => {
	if (typeof req.body?.localOnly === 'boolean') setLocalOnly(req.body.localOnly)
	if (typeof req.body?.spacing === 'number') SETTINGS.spacing = Math.min(2, Math.max(0.6, req.body.spacing))
	if (typeof req.body?.autoTidy === 'boolean') SETTINGS.autoTidy = req.body.autoTidy
	res.json({ ok: true, ...llmStatus(), spacing: SETTINGS.spacing, autoTidy: SETTINGS.autoTidy })
})

// frames = the diagrams on a meeting's canvas
app.get('/api/rooms/:room/frames', (req, res) => res.json({ ok: true, frames: getFrames(getRoom(req.params.room)) }))
app.post('/api/rooms/:room/frames', (req, res) => {
	const type = BOARD_TYPES[String(req.body?.type ?? '')] ? String(req.body.type) : DEFAULT_BOARD_TYPE
	const f = createFrame(getRoom(req.params.room), type, String(req.body?.title ?? '').slice(0, 40))
	res.json({ ok: true, frame: f })
})

app.get('/api/health', (_req, res) => {
	const detail = [...rooms.entries()].map(([id, room]) => ({
		id,
		shapes: room.doc.getMap('shapes').size,
		connectors: room.doc.getMap('connectors').size,
		online: room.conns.size,
	}))
	res.json({ ok: true, rooms: detail })
})

const server = createServer(app)
const wss = new WebSocketServer({ server })
wss.on('connection', (conn, req) => onConnection(conn as unknown as WebSocket, req))

server.listen(PORT, HOST, () => {
	console.log(`\n  yjs sync server  ws://${HOST}:${PORT}/:room`)
	console.log(`  bot endpoint     POST http://${HOST}:${PORT}/api/bot/:room/sticky`)
	console.log(`  auth: ${API_KEY ? 'X-API-Key required' : 'open (set WB_API_KEY to lock)'}\n`)
})

// Graceful shutdown: flush pending debounced saves so a restart (tsx watch / Ctrl-C) never loses the last edits.
function shutdown() {
	flushAll()
	try {
		wss.close()
	} catch {}
	server.close(() => process.exit(0))
	setTimeout(() => process.exit(0), 1000).unref()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
