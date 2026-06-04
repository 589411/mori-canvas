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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { planBoard, type BoardPlan } from './agent.ts'
import { transcribe } from './stt.ts'

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

/** Place one sticky into the shared room. Returns its id. */
function placeSticky(room: Room, text: string, color: string, drawnBy: string): string {
	const shapes = room.doc.getMap('shapes')
	const id = rid('sticky')
	const n = shapes.size
	shapes.set(id, {
		id,
		type: 'sticky',
		x: 120 + (n % 5) * 240,
		y: 120 + Math.floor(n / 5) * 240,
		w: 200,
		h: 200,
		text,
		color,
		drawnBy,
	})
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
function existingStickies(room: Room): { id: string; text: string }[] {
	return [...room.doc.getMap('shapes').values()]
		.filter((s: any) => s.type === 'sticky')
		.sort((a: any, b: any) => (a.id < b.id ? -1 : 1))
		.map((s: any) => ({ id: s.id, text: s.text }))
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
	existingIds: string[]
): Promise<{ ids: string[]; connectorsDrawn: number }> {
	const room = getRoom(roomName)
	const shapes = room.doc.getMap('shapes')
	const connectors = room.doc.getMap('connectors')
	const newIds: string[] = []
	const E = existingIds.length
	let drawn = 0
	try {
		// Stream the stickies in one-by-one, moving Mori's live cursor to each so
		// every connected human sees Mori actually drawing. The grid slot is read
		// from the LIVE shapes.size inside the transact, so concurrent writes can't
		// make two stickies land on the same cell (TOCTOU-safe).
		for (const s of plan.stickies) {
			const id = rid('sticky')
			let cx = 0
			let cy = 0
			room.doc.transact(() => {
				const n = shapes.size
				const x = 120 + (n % 5) * 240
				const y = 120 + Math.floor(n / 5) * 240
				cx = x + 100
				cy = y + 100
				shapes.set(id, { id, type: 'sticky', x, y, w: 200, h: 200, text: s.text, color: s.color, drawnBy })
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

app.post('/api/bot/:room/sticky', (req, res) => {
	const { room } = req.params
	const text: string = req.body?.text ?? `bot @ ${new Date().toLocaleTimeString()}`
	const color: string = req.body?.color ?? 'yellow'
	const id = drawSticky(room, text, color)
	res.json({ ok: true, room, id, text, color })
})

// Agent: transcript -> board plan (Groq->Ollama) -> stickies + connectors.
// Wrapped in a per-room lock so concurrent runs queue instead of racing.
app.post('/api/agent/:room', async (req, res) => {
	const transcript = String(req.body?.transcript ?? '').trim()
	if (!transcript) {
		res.status(400).json({ ok: false, error: 'transcript required' })
		return
	}
	try {
		const out = await withRoomLock(req.params.room, async () => {
			const existing = existingStickies(getRoom(req.params.room))
			const { plan, provider } = await planBoard(transcript, existing.map((e) => e.text))
			const r = await applyPlan(req.params.room, plan, 'agent', existing.map((e) => e.id))
			return { provider, added: plan.stickies, connectors: r.connectorsDrawn, ids: r.ids }
		})
		res.json({ ok: true, ...out })
	} catch (e) {
		console.error('[agent] error', e)
		res.status(500).json({ ok: false, error: (e as Error).message })
	}
})

// Voice: raw audio bytes -> mori-ear STT -> agent -> board. Full chain.
app.post('/api/voice/:room', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
	const ext = String(req.query.ext ?? 'webm').replace(/[^a-z0-9]/gi, '') || 'webm'
	const tmp = pathJoin(tmpdir(), `voice-${rid('a')}.${ext}`)
	try {
		await writeFile(tmp, req.body as Buffer)
		const transcript = await transcribe(tmp) // STT outside the lock (room-independent)
		if (!transcript) {
			res.json({ ok: true, transcript: '', stickies: 0, note: 'empty transcript' })
			return
		}
		const out = await withRoomLock(req.params.room, async () => {
			const existing = existingStickies(getRoom(req.params.room))
			const { plan, provider } = await planBoard(transcript, existing.map((e) => e.text))
			const r = await applyPlan(req.params.room, plan, 'voice', existing.map((e) => e.id))
			return { provider, stickies: r.ids.length, connectors: r.connectorsDrawn }
		})
		res.json({ ok: true, transcript, ...out })
	} catch (e) {
		console.error('[voice] error', e)
		res.status(500).json({ ok: false, error: (e as Error).message })
	} finally {
		unlink(tmp).catch(() => {})
	}
})

// Export the board as a Markdown meeting note (kind = sticky colour).
const KIND_BY_COLOR: Record<string, string> = { yellow: '主題', green: '待辦', blue: '決議', red: '風險' }
app.get('/api/export/:room', (req, res) => {
	const doc = getRoom(req.params.room).doc
	const shapes = [...doc.getMap('shapes').values()].filter((s: any) => s.type === 'sticky') as any[]
	const conns = [...doc.getMap('connectors').values()] as any[]
	const byKind: Record<string, string[]> = {}
	for (const s of shapes) (byKind[KIND_BY_COLOR[s.color] || '其他'] ??= []).push(s.text)
	let md = `# 會議白板:${req.params.room}\n\n`
	for (const k of ['主題', '決議', '待辦', '風險', '其他']) {
		if (byKind[k]?.length) md += `## ${k}\n${byKind[k].map((t) => `- ${t}`).join('\n')}\n\n`
	}
	if (conns.length) {
		const txt = (id: string) => shapes.find((s) => s.id === id)?.text ?? '?'
		md += `## 關聯\n${conns.map((c) => `- ${txt(c.from)} → ${txt(c.to)}`).join('\n')}\n`
	}
	res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
	res.send(md)
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
