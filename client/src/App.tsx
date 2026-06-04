import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Group, Rect, Text, Arrow } from 'react-konva'
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
type Connector = { id: string; from: string; to: string }

const COLORS: Record<string, string> = {
	yellow: '#ffd96b',
	green: '#7ed09e',
	red: '#f08c8c',
	blue: '#6ba8e8',
}
const SYNC_HTTP = `http://${location.hostname}:1234`
const SYNC_WS = `ws://${location.hostname}:1234`

const DEMO_TRANSCRIPT =
	'今天跟客戶開會討論線上預約系統。客戶現在用紙本登記,常常重複預約,想要病患自己選時段。我們報季繳方案。客戶擔心櫃台人員不會用後台,我說會做教學影片。風險是診所內網要先確認能不能對外。下一步我這邊下週三前先給一個 demo。'

// where the center->target line exits a w×h rectangle centred at (cx,cy)
function edgePoint(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number): [number, number] {
	const dx = tx - cx
	const dy = ty - cy
	if (dx === 0 && dy === 0) return [cx, cy]
	const s = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity)
	return [cx + dx * s, cy + dy * s]
}

export default function App() {
	const room = new URLSearchParams(location.search).get('room') ?? 'spike'

	const { doc, yShapes, yConnectors, provider } = useMemo(() => {
		const doc = new Y.Doc()
		const provider = new WebsocketProvider(SYNC_WS, room, doc)
		const yShapes = doc.getMap<Sticky>('shapes')
		const yConnectors = doc.getMap<Connector>('connectors')
		;(window as any).__getShapes = () => Array.from(yShapes.values())
		;(window as any).__getConnectors = () => Array.from(yConnectors.values())
		return { doc, yShapes, yConnectors, provider }
	}, [room])

	const [shapes, setShapes] = useState<Sticky[]>([])
	const [connectors, setConnectors] = useState<Connector[]>([])
	const [status, setStatus] = useState('connecting')
	const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [connectMode, setConnectMode] = useState(false)
	const [connectFrom, setConnectFrom] = useState<string | null>(null)
	const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
	const [agentText, setAgentText] = useState(DEMO_TRANSCRIPT)
	const [busy, setBusy] = useState('')
	const editRef = useRef<HTMLTextAreaElement>(null)

	// --- yjs mutations (all wrapped in one transaction) ---
	const tx = (fn: () => void) => doc.transact(fn)
	const patchShape = (id: string, patch: Partial<Sticky>) => {
		const cur = yShapes.get(id)
		if (cur) tx(() => yShapes.set(id, { ...cur, ...patch }))
	}
	const addSticky = (x: number, y: number, text = '', color = 'yellow') => {
		const id = `sticky-${Math.random().toString(36).slice(2, 10)}`
		tx(() => yShapes.set(id, { id, x, y, w: 200, h: 200, text, color, drawnBy: 'user' }))
		return id
	}
	const deleteSticky = (id: string) =>
		tx(() => {
			yShapes.delete(id)
			for (const [cid, c] of yConnectors) if (c.from === id || c.to === id) yConnectors.delete(cid)
		})
	const addConnector = (from: string, to: string) => {
		const id = `conn-${Math.random().toString(36).slice(2, 10)}`
		tx(() => yConnectors.set(id, { id, from, to }))
	}
	const clearAll = () =>
		tx(() => {
			yShapes.clear()
			yConnectors.clear()
		})

	useEffect(() => {
		const sync = () => setShapes(Array.from(yShapes.values()))
		const syncC = () => setConnectors(Array.from(yConnectors.values()))
		sync()
		syncC()
		yShapes.observe(sync)
		yConnectors.observe(syncC)
		const onStatus = (e: { status: string }) => setStatus(e.status)
		provider.on('status', onStatus)
		provider.on('sync', (s: boolean) => s && setStatus('synced'))
		const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
		window.addEventListener('resize', onResize)
		return () => {
			yShapes.unobserve(sync)
			yConnectors.unobserve(syncC)
			provider.off('status', onStatus)
			window.removeEventListener('resize', onResize)
			provider.destroy()
		}
	}, [yShapes, yConnectors, provider])

	// keyboard delete (but not while editing text)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (editing) return
			if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
				e.preventDefault()
				deleteSticky(selectedId)
				setSelectedId(null)
			}
			if (e.key === 'Escape') {
				setSelectedId(null)
				setConnectFrom(null)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [selectedId, editing])

	useEffect(() => {
		if (editing) editRef.current?.focus()
	}, [editing])

	const byId = (id: string) => shapes.find((s) => s.id === id)

	function onStickyClick(s: Sticky) {
		if (connectMode) {
			if (!connectFrom) setConnectFrom(s.id)
			else if (connectFrom !== s.id) {
				addConnector(connectFrom, s.id)
				setConnectFrom(null)
			}
			return
		}
		setSelectedId(s.id)
	}

	function onStageDblClick(e: any) {
		// only when clicking empty canvas (target is the stage itself)
		if (e.target !== e.target.getStage()) return
		const pos = e.target.getStage().getPointerPosition()
		const id = addSticky(pos.x - 100, pos.y - 100, '', 'yellow')
		setEditing({ id, value: '' })
		setSelectedId(id)
	}

	async function runAgent() {
		if (!agentText.trim()) return
		setBusy('agent 思考中…')
		try {
			const r = await fetch(`${SYNC_HTTP}/api/agent/${encodeURIComponent(room)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transcript: agentText }),
			}).then((x) => x.json())
			setBusy(r.ok ? `agent(${r.provider}):${r.stickies?.length ?? 0} 張、${r.connectors?.length ?? 0} 連線` : `錯誤:${r.error}`)
		} catch (e) {
			setBusy(`錯誤:${(e as Error).message}`)
		}
	}

	// voice: mic -> /api/voice -> ear -> agent -> board
	const recRef = useRef<MediaRecorder | null>(null)
	const [recording, setRecording] = useState(false)
	async function toggleRecord() {
		if (recording) {
			recRef.current?.stop()
			return
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			const chunks: BlobPart[] = []
			const mr = new MediaRecorder(stream)
			mr.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
			mr.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop())
				setRecording(false)
				setBusy('轉錄 + agent 中…')
				const blob = new Blob(chunks, { type: 'audio/webm' })
				try {
					const r = await fetch(`${SYNC_HTTP}/api/voice/${encodeURIComponent(room)}?ext=webm`, {
						method: 'POST',
						headers: { 'Content-Type': 'audio/webm' },
						body: blob,
					}).then((x) => x.json())
					setBusy(r.ok ? `聽到「${r.transcript || '(空)'}」→ ${r.stickies ?? 0} 張` : `錯誤:${r.error}`)
				} catch (e) {
					setBusy(`錯誤:${(e as Error).message}`)
				}
			}
			recRef.current = mr
			mr.start()
			setRecording(true)
			setBusy('錄音中…再按一次停止')
		} catch (e) {
			setBusy(`麥克風錯誤:${(e as Error).message}`)
		}
	}

	const btn: React.CSSProperties = { font: '13px system-ui', padding: '4px 8px', cursor: 'pointer' }

	// exposed for verification / console poking
	;(window as any).__wb = { addSticky, patchShape, deleteSticky, addConnector, clearAll }

	return (
		<div style={{ position: 'fixed', inset: 0, background: '#fafafa' }}>
			<Stage
				width={size.w}
				height={size.h}
				onMouseDown={(e: any) => {
					if (e.target === e.target.getStage()) {
						setSelectedId(null)
						setConnectFrom(null)
					}
				}}
				onDblClick={onStageDblClick}
			>
				<Layer>
					{/* connectors behind stickies */}
					{connectors.map((c) => {
						const a = byId(c.from)
						const b = byId(c.to)
						if (!a || !b) return null
						const ac: [number, number] = [a.x + a.w / 2, a.y + a.h / 2]
						const bc: [number, number] = [b.x + b.w / 2, b.y + b.h / 2]
						const [x1, y1] = edgePoint(ac[0], ac[1], a.w / 2, a.h / 2, bc[0], bc[1])
						const [x2, y2] = edgePoint(bc[0], bc[1], b.w / 2, b.h / 2, ac[0], ac[1])
						return (
							<Arrow
								key={c.id}
								points={[x1, y1, x2, y2]}
								stroke="#555"
								fill="#555"
								strokeWidth={2}
								pointerLength={9}
								pointerWidth={9}
							/>
						)
					})}
					{shapes.map((s) => {
						const selected = s.id === selectedId
						const pending = s.id === connectFrom
						return (
							<Group
								key={s.id}
								x={s.x}
								y={s.y}
								draggable
								onDragStart={() => setSelectedId(s.id)}
								onDragMove={(e: any) => patchShape(s.id, { x: e.target.x(), y: e.target.y() })}
								onClick={() => onStickyClick(s)}
								onTap={() => onStickyClick(s)}
								onDblClick={(e: any) => {
									e.cancelBubble = true
									setEditing({ id: s.id, value: s.text })
								}}
							>
								<Rect
									width={s.w}
									height={s.h}
									fill={COLORS[s.color] ?? s.color}
									cornerRadius={8}
									shadowColor="black"
									shadowOpacity={0.2}
									shadowBlur={10}
									shadowOffsetY={4}
									stroke={pending ? '#2563eb' : selected ? '#111' : undefined}
									strokeWidth={pending ? 4 : selected ? 2 : 0}
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
						)
					})}
				</Layer>
			</Stage>

			{/* text editor overlay */}
			{editing &&
				(() => {
					const s = byId(editing.id)
					if (!s) return null
					return (
						<textarea
							ref={editRef}
							value={editing.value}
							onChange={(e) => setEditing({ id: editing.id, value: e.target.value })}
							onBlur={() => {
								patchShape(editing.id, { text: editing.value })
								setEditing(null)
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault()
									;(e.target as HTMLTextAreaElement).blur()
								}
							}}
							style={{
								position: 'fixed',
								left: s.x + 8,
								top: s.y + 8,
								width: s.w - 16,
								height: s.h - 16,
								border: '2px solid #2563eb',
								borderRadius: 6,
								padding: 8,
								font: '18px system-ui',
								textAlign: 'center',
								resize: 'none',
								background: COLORS[s.color] ?? s.color,
								zIndex: 2000,
							}}
						/>
					)
				})()}

			{/* top toolbar */}
			<div style={bar}>
				<strong>room:</strong> {room}
				<span style={{ color: '#888' }}>{status}</span>
				<span style={{ color: '#888' }}>{shapes.length} 張 · {connectors.length} 連線</span>
				<button style={btn} onClick={() => addSticky(140, 140, '', 'yellow') && undefined}>
					＋ 便利貼
				</button>
				<button
					style={{ ...btn, background: connectMode ? '#dbeafe' : undefined }}
					onClick={() => {
						setConnectMode((v) => !v)
						setConnectFrom(null)
					}}
				>
					{connectMode ? '連線模式:開(點兩張)' : '連線模式'}
				</button>
				<button style={btn} onClick={() => selectedId && deleteSticky(selectedId)}>
					刪除選取
				</button>
				<button style={btn} onClick={clearAll}>
					清空
				</button>
			</div>

			{/* hint */}
			<div style={hint}>雙擊空白處新增便利貼 · 雙擊便利貼改字 · 拖拉移動 · 點選後 Delete 刪除</div>

			{/* agent / voice panel */}
			<div style={panel}>
				<div style={{ fontWeight: 600, marginBottom: 4 }}>會議 → 白板</div>
				<textarea
					value={agentText}
					onChange={(e) => setAgentText(e.target.value)}
					placeholder="貼一段會議逐字稿…"
					style={{ width: 300, height: 70, font: '12px system-ui', resize: 'vertical' }}
				/>
				<div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
					<button style={btn} onClick={runAgent}>
						丟給 agent
					</button>
					<button style={{ ...btn, background: recording ? '#fecaca' : undefined }} onClick={toggleRecord}>
						{recording ? '■ 停止' : '● 錄音'}
					</button>
				</div>
				{busy && <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>{busy}</div>}
			</div>
		</div>
	)
}

const bar: React.CSSProperties = {
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
}
const hint: React.CSSProperties = {
	position: 'fixed',
	bottom: 8,
	left: '50%',
	transform: 'translateX(-50%)',
	zIndex: 1000,
	color: '#999',
	font: '12px system-ui',
	background: 'rgba(255,255,255,0.7)',
	padding: '2px 8px',
	borderRadius: 6,
}
const panel: React.CSSProperties = {
	position: 'fixed',
	left: 12,
	bottom: 36,
	zIndex: 1000,
	background: 'rgba(255,255,255,0.96)',
	border: '1px solid #ddd',
	borderRadius: 8,
	padding: 10,
	boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
	font: '13px system-ui, sans-serif',
}
