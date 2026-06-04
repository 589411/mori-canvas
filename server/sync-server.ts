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
	const awareness = new awarenessProtocol.Awareness(doc)
	const r: Room = { doc, awareness, conns: new Map() }

	// Any doc change (from a client OR the server-side bot) → broadcast to all.
	doc.on('update', (update: Uint8Array) => {
		const enc = encoding.createEncoder()
		encoding.writeVarUint(enc, messageSync)
		syncProtocol.writeUpdate(enc, update)
		broadcast(r, encoding.toUint8Array(enc))
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
	let roomName = (req.url || '/').slice(1).split('?')[0] || 'default'
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
function applyPlan(roomName: string, plan: BoardPlan, drawnBy: string, existingIds: string[]): string[] {
	const room = getRoom(roomName)
	const shapes = room.doc.getMap('shapes')
	const connectors = room.doc.getMap('connectors')
	const newIds: string[] = []
	const E = existingIds.length
	room.doc.transact(() => {
		const startN = shapes.size
		plan.stickies.forEach((s, i) => {
			const id = rid('sticky')
			const n = startN + i
			shapes.set(id, {
				id,
				type: 'sticky',
				x: 120 + (n % 5) * 240,
				y: 120 + Math.floor(n / 5) * 240,
				w: 200,
				h: 200,
				text: s.text,
				color: s.color,
				drawnBy,
			})
			newIds.push(id)
		})
		const resolve = (idx: number): string | undefined => (idx < E ? existingIds[idx] : newIds[idx - E])
		for (const [a, b] of plan.connectors) {
			const from = resolve(a)
			const to = resolve(b)
			if (from && to && from !== to && shapes.has(from) && shapes.has(to)) {
				const cid = rid('conn')
				connectors.set(cid, { id: cid, from, to })
			}
		}
	})
	console.log(`[agent] +${newIds.length} stickies, +${plan.connectors.length} connectors in "${roomName}"`)
	return newIds
}

const app = express()
app.use(express.json())
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
	if (req.method === 'OPTIONS') {
		res.sendStatus(204)
		return
	}
	next()
})

app.post('/api/bot/:room/sticky', (req, res) => {
	const { room } = req.params
	const text: string = req.body?.text ?? `bot @ ${new Date().toLocaleTimeString()}`
	const color: string = req.body?.color ?? 'yellow'
	const id = drawSticky(room, text, color)
	res.json({ ok: true, room, id, text, color })
})

// Agent: transcript -> board plan (Groq->Ollama) -> stickies + connectors.
app.post('/api/agent/:room', async (req, res) => {
	const transcript = String(req.body?.transcript ?? '').trim()
	if (!transcript) {
		res.status(400).json({ ok: false, error: 'transcript required' })
		return
	}
	try {
		const existing = existingStickies(getRoom(req.params.room))
		const { plan, provider } = await planBoard(transcript, existing.map((e) => e.text))
		const ids = applyPlan(req.params.room, plan, 'agent', existing.map((e) => e.id))
		res.json({ ok: true, provider, added: plan.stickies, connectors: plan.connectors.length, ids })
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
		const transcript = await transcribe(tmp)
		if (!transcript) {
			res.json({ ok: true, transcript: '', stickies: 0, note: 'empty transcript' })
			return
		}
		const existing = existingStickies(getRoom(req.params.room))
		const { plan, provider } = await planBoard(transcript, existing.map((e) => e.text))
		const ids = applyPlan(req.params.room, plan, 'voice', existing.map((e) => e.id))
		res.json({ ok: true, transcript, provider, stickies: ids.length, connectors: plan.connectors.length })
	} catch (e) {
		console.error('[voice] error', e)
		res.status(500).json({ ok: false, error: (e as Error).message })
	} finally {
		unlink(tmp).catch(() => {})
	}
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

server.listen(PORT, () => {
	console.log(`\n  yjs sync server  ws://localhost:${PORT}/:room`)
	console.log(`  bot endpoint     POST http://localhost:${PORT}/api/bot/:room/sticky\n`)
})
