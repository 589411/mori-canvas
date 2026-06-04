import { useEffect, useMemo, useState } from 'react'
import { Stage, Layer, Group, Rect, Text } from 'react-konva'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

type Sticky = {
	id: string
	x: number
	y: number
	w: number
	h: number
	text: string
	color: string
	drawnBy?: string
}

const COLORS: Record<string, string> = {
	yellow: '#ffd96b',
	green: '#7ed09e',
	red: '#f08c8c',
	blue: '#6ba8e8',
}

const SYNC_HTTP = `http://${location.hostname}:1234`
const SYNC_WS = `ws://${location.hostname}:1234`

export default function App() {
	const room = new URLSearchParams(location.search).get('room') ?? 'spike'

	const { yShapes, provider } = useMemo(() => {
		const doc = new Y.Doc()
		const provider = new WebsocketProvider(SYNC_WS, room, doc)
		const yShapes = doc.getMap<Sticky>('shapes')
		// exposed for verification / poking from the console
		;(window as any).__getShapes = () => Array.from(yShapes.values())
		return { doc, yShapes, provider }
	}, [room])

	const [shapes, setShapes] = useState<Sticky[]>([])
	const [status, setStatus] = useState('connecting')
	const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })

	useEffect(() => {
		const sync = () => setShapes(Array.from(yShapes.values()))
		sync()
		yShapes.observe(sync)
		const onStatus = (e: { status: string }) => setStatus(e.status)
		provider.on('status', onStatus)
		provider.on('sync', (isSynced: boolean) => {
			if (isSynced) setStatus('synced')
		})
		const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
		window.addEventListener('resize', onResize)
		return () => {
			yShapes.unobserve(sync)
			provider.off('status', onStatus)
			window.removeEventListener('resize', onResize)
			provider.destroy()
		}
	}, [yShapes, provider])

	async function botDraw() {
		await fetch(`${SYNC_HTTP}/api/bot/${encodeURIComponent(room)}/sticky`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: `bot @ ${new Date().toLocaleTimeString()}`, color: 'blue' }),
		})
	}

	return (
		<div style={{ position: 'fixed', inset: 0, background: '#fafafa' }}>
			<Stage width={size.w} height={size.h}>
				<Layer>
					{shapes.map((s) => (
						<Group key={s.id} x={s.x} y={s.y}>
							<Rect
								width={s.w}
								height={s.h}
								fill={COLORS[s.color] ?? s.color}
								cornerRadius={8}
								shadowColor="black"
								shadowOpacity={0.2}
								shadowBlur={10}
								shadowOffsetY={4}
							/>
							<Text
								text={s.text}
								width={s.w}
								height={s.h}
								padding={16}
								fontSize={20}
								fontFamily="system-ui, sans-serif"
								fill="#111"
								align="center"
								verticalAlign="middle"
							/>
						</Group>
					))}
				</Layer>
			</Stage>
			<div
				style={{
					position: 'fixed',
					top: 8,
					left: '50%',
					transform: 'translateX(-50%)',
					zIndex: 1000,
					display: 'flex',
					gap: 10,
					alignItems: 'center',
					background: 'rgba(255,255,255,0.94)',
					border: '1px solid #ddd',
					borderRadius: 8,
					padding: '6px 12px',
					font: '13px system-ui, sans-serif',
					boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
				}}
			>
				<strong>room:</strong> {room}
				<span style={{ color: '#888' }}>status: {status}</span>
				<span style={{ color: '#888' }}>shapes: {shapes.length}</span>
				<button onClick={botDraw}>Bot draws a sticky</button>
			</div>
		</div>
	)
}
