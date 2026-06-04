/**
 * Standalone bot as a real yjs PEER (not via the server's in-process doc).
 * Proves any external agent process can join the room over the network and write.
 *
 *   npm run bot -- "text" [room] [color]
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WS from 'ws'

const [, , textArg, roomArg, colorArg] = process.argv
const text = textArg ?? `peer-bot @ ${new Date().toLocaleTimeString()}`
const room = roomArg ?? 'spike'
const color = colorArg ?? 'green'
const url = process.env.SYNC_WS ?? 'ws://localhost:1234'

const doc = new Y.Doc()
// y-websocket needs a WebSocket impl; in Node we polyfill with `ws`.
const provider = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: WS as any })

provider.on('sync', (isSynced: boolean) => {
	if (!isSynced) return
	const shapes = doc.getMap('shapes')
	const id = `sticky-${Math.random().toString(36).slice(2, 10)}`
	const n = shapes.size
	doc.transact(() => {
		shapes.set(id, {
			id,
			type: 'sticky',
			x: 120 + (n % 5) * 240,
			y: 120 + Math.floor(n / 5) * 240,
			w: 200,
			h: 200,
			text,
			color,
			drawnBy: 'peer-bot',
		})
	})
	console.log(`wrote ${id} -> "${text}" in room "${room}"`)
	// give the update time to flush to the server, then exit
	setTimeout(() => {
		provider.destroy()
		process.exit(0)
	}, 600)
})

setTimeout(() => {
	console.error('timed out waiting for sync')
	process.exit(1)
}, 8000)
