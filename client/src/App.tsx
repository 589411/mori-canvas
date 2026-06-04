import { useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Group, Rect, Text, Arrow, Circle } from 'react-konva'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import QRCode from 'qrcode'

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
// Same-origin: the API and the sync websocket both go through Vite's reverse
// proxy, so this works over http OR https (and behind a tunnel) with no hardcoded
// port. ws upgrades to wss automatically when the page is served over https.
const SYNC_HTTP = '' // relative -> /api/... on the current origin
const SYNC_WS = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sync`

const DEMO_TRANSCRIPT =
	'今天跟客戶開會討論線上預約系統。客戶現在用紙本登記,常常重複預約,想要病患自己選時段。我們報季繳方案。客戶擔心櫃台人員不會用後台,我說會做教學影片。風險是診所內網要先確認能不能對外。下一步我這邊下週三前先給一個 demo。'

// short, human-readable room code (no ambiguous chars). Doubles as the "房號".
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function genCode(n = 4): string {
	let s = ''
	for (let i = 0; i < n; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
	return s
}
// use ?room= if present; otherwise mint a fresh code and put it in the URL (shareable)
function resolveRoom(): string {
	const p = new URLSearchParams(location.search)
	let r = p.get('room')
	if (!r) {
		r = genCode()
		p.set('room', r)
		history.replaceState(null, '', location.pathname + '?' + p.toString())
	}
	return r
}

// where the center->target line exits a w×h rectangle centred at (cx,cy)
function edgePoint(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number): [number, number] {
	const dx = tx - cx
	const dy = ty - cy
	if (dx === 0 && dy === 0) return [cx, cy]
	const s = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity)
	return [cx + dx * s, cy + dy * s]
}

export default function App() {
	const [room] = useState(resolveRoom)
	const [lanIp, setLanIp] = useState('')
	useEffect(() => {
		// ask the server for its LAN IP so the share URL is reachable from other
		// devices (localhost would point a phone at itself)
		fetch('/api/lan')
			.then((r) => r.json())
			.then((d) => d.ip && setLanIp(d.ip))
			.catch(() => {})
	}, [])
	const isLocalHostPage = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname)
	const shareHost = isLocalHostPage && lanIp ? lanIp : location.hostname
	const shareUrl = `${location.protocol}//${shareHost}${location.port ? ':' + location.port : ''}${location.pathname}?room=${encodeURIComponent(room)}`

	const { doc, yShapes, yConnectors, provider, undoMgr, LOCAL } = useMemo(() => {
		const doc = new Y.Doc()
		const provider = new WebsocketProvider(SYNC_WS, room, doc)
		const yShapes = doc.getMap<Sticky>('shapes')
		const yConnectors = doc.getMap<Connector>('connectors')
		const LOCAL = { local: true } // origin tag so undo only tracks MY edits, not remote/Mori
		const undoMgr = new Y.UndoManager([yShapes, yConnectors], { trackedOrigins: new Set([LOCAL]) })
		;(window as any).__getShapes = () => Array.from(yShapes.values())
		;(window as any).__getConnectors = () => Array.from(yConnectors.values())
		return { doc, yShapes, yConnectors, provider, undoMgr, LOCAL }
	}, [room])

	const [shapes, setShapes] = useState<Sticky[]>([])
	const [connectors, setConnectors] = useState<Connector[]>([])
	const [status, setStatus] = useState('connecting')
	const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
	const [view, setView] = useState({ x: 0, y: 0, scale: 1 }) // canvas pan/zoom
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [selectedConnId, setSelectedConnId] = useState<string | null>(null)
	const [connectMode, setConnectMode] = useState(false)
	const [connectFrom, setConnectFrom] = useState<string | null>(null)
	const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
	const [agentText, setAgentText] = useState(DEMO_TRANSCRIPT)
	const [busy, setBusy] = useState('')
	const editRef = useRef<HTMLTextAreaElement>(null)
	const stageRef = useRef<any>(null)
	const dragTs = useRef(0)
	const pinchRef = useRef(0)
	const [shareOpen, setShareOpen] = useState(false)
	const [qrUrl, setQrUrl] = useState('')
	const [joinCode, setJoinCode] = useState('')
	const [roomList, setRoomList] = useState<{ id: string; shapes: number; online: number }[]>([])
	const [panelOpen, setPanelOpen] = useState(window.innerWidth >= 700) // collapse agent panel on small screens

	// presence: my identity (persistent name + colour) + everyone else's cursors
	const [myName, setMyName] = useState(() => localStorage.getItem('wb-name') || '訪客-' + genCode(3))
	const myColor = useMemo(
		() => ['#e11d48', '#0891b2', '#ea580c', '#16a34a', '#9333ea'][Math.floor(Math.random() * 5)],
		[]
	)
	const me = useMemo(() => ({ name: myName, color: myColor }), [myName, myColor])
	useEffect(() => {
		localStorage.setItem('wb-name', myName)
		;(provider as any).awareness.setLocalStateField('user', me)
	}, [me, provider, myName])
	const [cursors, setCursors] = useState<{ id: number; name: string; color: string; x: number; y: number }[]>([])
	const cursorTs = useRef(0)

	// --- yjs mutations (tagged LOCAL so the UndoManager tracks them) ---
	const tx = (fn: () => void) => doc.transact(fn, LOCAL)
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
	const deleteConnector = (id: string) => tx(() => yConnectors.delete(id))
	const clearAll = () =>
		tx(() => {
			yShapes.clear()
			yConnectors.clear()
		})

	function exportMd() {
		window.open(`${SYNC_HTTP}/api/export/${encodeURIComponent(room)}`, '_blank')
	}
	function joinRoom() {
		const c = joinCode.trim().toUpperCase()
		if (c && c !== room) location.href = `${location.pathname}?room=${encodeURIComponent(c)}`
	}
	function exportPng() {
		const uri = stageRef.current?.toDataURL({ pixelRatio: 2 })
		if (!uri) return
		const a = document.createElement('a')
		a.href = uri
		a.download = `whiteboard-${room}.png`
		a.click()
	}

	useEffect(() => {
		const sync = () => setShapes(Array.from(yShapes.values()))
		const syncC = () => setConnectors(Array.from(yConnectors.values()))
		sync()
		syncC()
		yShapes.observe(sync)
		yConnectors.observe(syncC)
		// presence: track everyone else's cursors (Mori + other humans)
		const aw = (provider as any).awareness
		const updateCursors = () => {
			const out: { id: number; name: string; color: string; x: number; y: number }[] = []
			aw.getStates().forEach((st: any, cid: number) => {
				if (cid === aw.clientID || !st?.cursor || !st?.user) return
				out.push({ id: cid, name: st.user.name, color: st.user.color, x: st.cursor.x, y: st.cursor.y })
			})
			setCursors(out)
		}
		aw.on('change', updateCursors)
		aw.setLocalStateField('user', me)
		updateCursors()
		const onStatus = (e: { status: string }) => setStatus(e.status)
		provider.on('status', onStatus)
		provider.on('sync', (s: boolean) => s && setStatus('synced'))
		const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
		window.addEventListener('resize', onResize)
		return () => {
			yShapes.unobserve(sync)
			yConnectors.unobserve(syncC)
			aw.off('change', updateCursors)
			provider.off('status', onStatus)
			window.removeEventListener('resize', onResize)
			provider.destroy()
		}
	}, [yShapes, yConnectors, provider])

	// keyboard: undo/redo + delete (but not while editing text)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (editing) return
			const mod = e.ctrlKey || e.metaKey
			if (mod && e.key.toLowerCase() === 'z') {
				e.preventDefault()
				if (e.shiftKey) undoMgr.redo()
				else undoMgr.undo()
				return
			}
			if (mod && e.key.toLowerCase() === 'y') {
				e.preventDefault()
				undoMgr.redo()
				return
			}
			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (selectedId) {
					e.preventDefault()
					deleteSticky(selectedId)
					setSelectedId(null)
				} else if (selectedConnId) {
					e.preventDefault()
					deleteConnector(selectedConnId)
					setSelectedConnId(null)
				}
			}
			if (e.key === 'Escape') {
				setSelectedId(null)
				setSelectedConnId(null)
				setConnectFrom(null)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [selectedId, selectedConnId, editing, undoMgr])

	useEffect(() => {
		if (editing) editRef.current?.focus()
	}, [editing])

	useEffect(() => {
		if (!shareOpen) return
		QRCode.toDataURL(shareUrl, { width: 240, margin: 1 }).then(setQrUrl).catch(() => setQrUrl(''))
		fetch('/api/rooms')
			.then((r) => r.json())
			.then((d) => setRoomList(d.rooms || []))
			.catch(() => {})
	}, [shareOpen, shareUrl])

	async function endThisRoom() {
		if (!window.confirm(`結束房間「${room}」?會清空給所有人。`)) return
		await fetch(`${SYNC_HTTP}/api/rooms/${encodeURIComponent(room)}/end`, { method: 'POST' }).catch(() => {})
	}

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
		// relative pointer position accounts for pan/zoom -> canvas coords
		const pos = e.target.getStage().getRelativePointerPosition()
		const id = addSticky(pos.x - 100, pos.y - 100, '', 'yellow')
		setEditing({ id, value: '' })
		setSelectedId(id)
	}

	function onWheel(e: any) {
		e.evt.preventDefault()
		const stage = e.target.getStage()
		const pointer = stage.getPointerPosition()
		const old = view.scale
		const worldX = (pointer.x - view.x) / old
		const worldY = (pointer.y - view.y) / old
		const next = Math.max(0.25, Math.min(3, e.evt.deltaY > 0 ? old / 1.1 : old * 1.1))
		setView({ scale: next, x: pointer.x - worldX * next, y: pointer.y - worldY * next })
	}

	function onTouchMove(e: any) {
		const t = e.evt.touches
		if (!t || t.length !== 2) return
		e.evt.preventDefault()
		const stage = e.target.getStage()
		stage.stopDrag() // two fingers = zoom, not pan
		const p1 = { x: t[0].clientX, y: t[0].clientY }
		const p2 = { x: t[1].clientX, y: t[1].clientY }
		const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
		const cx = (p1.x + p2.x) / 2
		const cy = (p1.y + p2.y) / 2
		if (pinchRef.current) {
			const old = view.scale
			const wx = (cx - view.x) / old
			const wy = (cy - view.y) / old
			const next = Math.max(0.25, Math.min(3, old * (dist / pinchRef.current)))
			setView({ scale: next, x: cx - wx * next, y: cy - wy * next })
		}
		pinchRef.current = dist
	}
	function onTouchEnd() {
		pinchRef.current = 0
	}

	function publishCursor(e: any) {
		const now = Date.now()
		if (now - cursorTs.current < 50) return
		cursorTs.current = now
		const p = e.target.getStage().getRelativePointerPosition()
		if (p) (provider as any).awareness.setLocalState({ user: me, cursor: { x: p.x, y: p.y } })
	}
	function clearCursor() {
		;(provider as any).awareness.setLocalState({ user: me, cursor: null })
	}

	async function runAgent() {
		if (!agentText.trim()) return
		setBusy('agent 思考中…')
		try {
			const r = await fetch(`${SYNC_HTTP}/api/agent/${encodeURIComponent(room)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ transcript: agentText, by: me.name }),
			}).then((x) => x.json())
			setBusy(r.ok ? `agent(${r.provider}):+${r.added?.length ?? 0} 張、+${r.connectors ?? 0} 連線` : `錯誤:${r.error}`)
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
		// Mic needs a SECURE context (https or localhost). A plain http LAN IP like
		// http://192.168.x.y is blocked by the browser → mediaDevices is undefined.
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
			setBusy(
				`麥克風被瀏覽器擋:此頁是 ${location.protocol}//${location.host},不是 localhost 也不是 HTTPS。` +
					`要錄音的筆電請改開 http://localhost:5174;手機要錄音需要 HTTPS。`
			)
			return
		}
		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		} catch (e) {
			const name = (e as any)?.name || ''
			const hint =
				name === 'NotAllowedError'
					? '(你按了拒絕,或瀏覽器擋了 — 點網址列左邊圖示把麥克風設成允許)'
					: name === 'NotFoundError'
						? '(系統找不到麥克風裝置)'
						: name === 'NotReadableError'
							? '(麥克風被別的程式佔用)'
							: ''
			setBusy(`麥克風錯誤:${name || (e as Error).message} ${hint}`)
			return
		}
		const chunks: BlobPart[] = []
		const mr = new MediaRecorder(stream)
		mr.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
		mr.onstop = async () => {
			stream.getTracks().forEach((t) => t.stop())
			setRecording(false)
			setBusy('轉錄 + agent 中…')
			// iOS Safari often records mp4/aac, not webm — use the actual mimeType so
			// the file extension matches (mori-ear/Groq Whisper accept mp4/m4a/ogg/webm).
			const type = mr.mimeType || 'audio/webm'
			const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'
			const blob = new Blob(chunks, { type })
			try {
				const r = await fetch(
					`${SYNC_HTTP}/api/voice/${encodeURIComponent(room)}?ext=${ext}&by=${encodeURIComponent(me.name)}`,
					{ method: 'POST', headers: { 'Content-Type': type }, body: blob }
				).then((x) => x.json())
				setBusy(r.ok ? `聽到「${r.transcript || '(空)'}」→ ${r.stickies ?? 0} 張` : `錯誤:${r.error}`)
			} catch (e) {
				setBusy(`錯誤:${(e as Error).message}`)
			}
		}
		recRef.current = mr
		mr.start()
		setRecording(true)
		setBusy('錄音中…再按一次停止')
	}

	const mobile = size.w < 700
	const btn: React.CSSProperties = {
		font: '13px system-ui',
		padding: mobile ? '8px 12px' : '5px 10px',
		cursor: 'pointer',
		borderRadius: 6,
		border: '1px solid #ccc',
		background: '#fff',
	}

	// exposed for verification / console poking
	;(window as any).__wb = { addSticky, patchShape, deleteSticky, addConnector, clearAll }
	;(window as any).__cursors = cursors

	return (
		<div style={{ position: 'fixed', inset: 0, background: '#fafafa' }}>
			<Stage
				ref={stageRef}
				width={size.w}
				height={size.h}
				x={view.x}
				y={view.y}
				scaleX={view.scale}
				scaleY={view.scale}
				draggable
				onWheel={onWheel}
				onDragMove={(e: any) => {
					if (e.target === e.target.getStage()) setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }))
				}}
				onDragEnd={(e: any) => {
					if (e.target === e.target.getStage()) setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }))
				}}
				onMouseDown={(e: any) => {
					if (e.target === e.target.getStage()) {
						setSelectedId(null)
						setSelectedConnId(null)
						setConnectFrom(null)
					}
				}}
				onMouseMove={publishCursor}
				onMouseLeave={clearCursor}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onDblClick={onStageDblClick}
				onDblTap={onStageDblClick}
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
						const sel = c.id === selectedConnId
						return (
							<Arrow
								key={c.id}
								points={[x1, y1, x2, y2]}
								stroke={sel ? '#2563eb' : '#555'}
								fill={sel ? '#2563eb' : '#555'}
								strokeWidth={sel ? 4 : 2}
								hitStrokeWidth={16}
								pointerLength={9}
								pointerWidth={9}
								onClick={() => {
									setSelectedConnId(c.id)
									setSelectedId(null)
								}}
								onTap={() => {
									setSelectedConnId(c.id)
									setSelectedId(null)
								}}
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
								onDragMove={(e: any) => {
									const now = Date.now()
									if (now - dragTs.current < 40) return // throttle yjs writes during drag
									dragTs.current = now
									patchShape(s.id, { x: e.target.x(), y: e.target.y() })
								}}
								onDragEnd={(e: any) => patchShape(s.id, { x: e.target.x(), y: e.target.y() })}
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
								{s.drawnBy && s.drawnBy !== 'user' && (
									<Text text={s.drawnBy} x={10} y={s.h - 19} fontSize={11} fill="rgba(0,0,0,0.5)" />
								)}
							</Group>
						)
					})}
					{/* live cursors of everyone else (Mori + other humans) */}
					{cursors.map((c) => (
						<Group key={c.id} x={c.x} y={c.y} listening={false}>
							<Circle radius={6} fill={c.color} stroke="#fff" strokeWidth={1.5} />
							<Rect x={10} y={-9} width={c.name.length * 8 + 12} height={18} cornerRadius={4} fill={c.color} />
							<Text x={16} y={-6} text={c.name} fontSize={12} fontStyle="bold" fill="#fff" />
						</Group>
					))}
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
								// map canvas coords -> screen through the pan/zoom transform
								left: view.x + s.x * view.scale,
								top: view.y + s.y * view.scale,
								width: s.w * view.scale,
								height: s.h * view.scale,
								border: '2px solid #2563eb',
								borderRadius: 6,
								padding: 8,
								boxSizing: 'border-box',
								fontSize: 18 * view.scale,
								fontFamily: 'system-ui',
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
				<strong>房號:</strong> {room}
				<button style={{ ...btn, background: '#dbeafe' }} onClick={() => setShareOpen(true)}>
					分享 / QR
				</button>
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
				<button style={btn} title="復原 Ctrl+Z" onClick={() => undoMgr.undo()}>
					↶
				</button>
				<button style={btn} title="重做 Ctrl+Shift+Z" onClick={() => undoMgr.redo()}>
					↷
				</button>
				<button
					style={btn}
					onClick={() => {
						if (selectedId) deleteSticky(selectedId)
						else if (selectedConnId) deleteConnector(selectedConnId)
					}}
				>
					刪除選取
				</button>
				<button
					style={{ ...btn, background: '#fef9c3' }}
					onClick={() => window.open(`${SYNC_HTTP}/api/summary/${encodeURIComponent(room)}`, '_blank')}
				>
					會議摘要
				</button>
				<button style={btn} onClick={exportMd}>
					匯出 MD
				</button>
				<button style={btn} onClick={exportPng}>
					匯出 PNG
				</button>
				<button style={btn} onClick={() => setView({ x: 0, y: 0, scale: 1 })}>
					回正
				</button>
				<button
					style={btn}
					onClick={() => {
						if (window.confirm('清空整個房間給所有人?')) clearAll()
					}}
				>
					清空
				</button>
			</div>

			{/* hint (desktop only) */}
			{!mobile && (
				<div style={hint}>
					雙擊空白新增 · 雙擊改字 · 拖拉移動 · 點便利貼/連線後 Delete 刪除 · Ctrl+Z 復原 · 空白拖曳平移 · 滾輪縮放
				</div>
			)}

			{/* agent / voice panel (collapsible; record stays visible) */}
			<div style={{ ...panel, width: mobile ? 'min(86vw, 320px)' : 320, left: mobile ? 8 : 12 }}>
				<div
					onClick={() => setPanelOpen((o) => !o)}
					style={{ fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
				>
					{panelOpen ? '▾' : '▸'} 會議 → 白板
				</div>
				{panelOpen && (
					<>
						<textarea
							value={agentText}
							onChange={(e) => setAgentText(e.target.value)}
							placeholder="貼一段會議逐字稿…"
							style={{ width: '100%', height: 70, font: '12px system-ui', resize: 'vertical', boxSizing: 'border-box', marginTop: 6 }}
						/>
						<button style={{ ...btn, width: '100%', marginTop: 6 }} onClick={runAgent}>
							丟給 agent
						</button>
					</>
				)}
				<button
					style={{
						...btn,
						width: '100%',
						marginTop: 8,
						fontSize: 15,
						padding: '10px',
						background: recording ? '#fecaca' : '#e0f2fe',
						fontWeight: 600,
					}}
					onClick={toggleRecord}
				>
					{recording ? '■ 停止錄音' : '● 錄音'}
				</button>
				{busy && <div style={{ marginTop: 6, fontSize: 12, color: '#444' }}>{busy}</div>}
			</div>

			{/* share modal: QR + 房號 + join-by-code */}
			{shareOpen && (
				<div
					onClick={() => setShareOpen(false)}
					style={{
						position: 'fixed',
						inset: 0,
						zIndex: 3000,
						background: 'rgba(0,0,0,0.45)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						font: '14px system-ui, sans-serif',
					}}
				>
					<div
						onClick={(e) => e.stopPropagation()}
						style={{
							background: '#fff',
							borderRadius: 12,
							padding: 24,
							width: 320,
							textAlign: 'center',
							boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
						}}
					>
						<div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
							<span style={{ color: '#666', fontSize: 13, whiteSpace: 'nowrap' }}>你的名字</span>
							<input
								value={myName}
								onChange={(e) => setMyName(e.target.value.slice(0, 24))}
								placeholder="會議裡顯示的名字"
								style={{ flex: 1, font: '14px system-ui', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
							/>
						</div>
						<div style={{ color: '#666', fontSize: 13 }}>用手機掃 QR,或輸入房號加入</div>
						<div style={{ fontSize: 40, fontWeight: 700, letterSpacing: 4, margin: '8px 0 14px' }}>{room}</div>
						{qrUrl ? (
							<img src={qrUrl} width={240} height={240} alt="QR" style={{ border: '1px solid #eee', borderRadius: 8 }} />
						) : (
							<div style={{ height: 240, lineHeight: '240px', color: '#aaa' }}>產生 QR 中…</div>
						)}
						<div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
							<input
								readOnly
								value={shareUrl}
								onFocus={(e) => e.currentTarget.select()}
								style={{ flex: 1, font: '12px system-ui', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6 }}
							/>
							<button
								style={{ ...btn, background: '#dbeafe' }}
								onClick={() => navigator.clipboard?.writeText(shareUrl)}
							>
								複製連結
							</button>
						</div>
						<hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #eee' }} />
						<div style={{ display: 'flex', gap: 6 }}>
							<input
								value={joinCode}
								onChange={(e) => setJoinCode(e.target.value)}
								onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
								placeholder="輸入房號加入別房…"
								style={{ flex: 1, font: '14px system-ui', padding: '6px 8px', border: '1px solid #ddd', borderRadius: 6, textTransform: 'uppercase' }}
							/>
							<button style={btn} onClick={joinRoom}>
								加入
							</button>
						</div>
						{roomList.length > 0 && (
							<div style={{ marginTop: 14, textAlign: 'left', maxHeight: 140, overflowY: 'auto' }}>
								<div style={{ color: '#666', fontSize: 12, marginBottom: 4 }}>進行中的房間</div>
								{roomList.map((r) => (
									<div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
										<span style={{ flex: 1, fontWeight: r.id === room ? 700 : 400 }}>
											{r.id} <span style={{ color: '#999', fontSize: 12 }}>· {r.online}人 · {r.shapes}張</span>
										</span>
										{r.id !== room && (
											<button
												style={{ ...btn, padding: '2px 8px' }}
												onClick={() => (location.href = `${location.pathname}?room=${encodeURIComponent(r.id)}`)}
											>
												進入
											</button>
										)}
									</div>
								))}
							</div>
						)}
						<div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
							<button style={{ ...btn, flex: 1, color: '#b91c1c' }} onClick={endThisRoom}>
								結束此房(清空)
							</button>
							<button style={{ ...btn, flex: 1 }} onClick={() => setShareOpen(false)}>
								關閉
							</button>
						</div>
					</div>
				</div>
			)}
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
	flexWrap: 'wrap',
	justifyContent: 'center',
	maxWidth: '96vw',
	gap: 6,
	alignItems: 'center',
	background: 'rgba(255,255,255,0.94)',
	border: '1px solid #ddd',
	borderRadius: 8,
	padding: '6px 10px',
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
