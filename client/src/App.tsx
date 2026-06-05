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
	owner?: string
	tags?: string[]
}
type Connector = { id: string; from: string; to: string }

const COLORS: Record<string, string> = {
	yellow: '#f3cf6b', // topic
	green: '#a6d6a1', // todo
	blue: '#9cbce8', // decision
	red: '#edaaa3', // risk
}
// a darker tint of each, for the little "kind" accent dot on a card
const KIND_ACCENT: Record<string, string> = {
	yellow: '#b88a18',
	green: '#4e9a5c',
	blue: '#4a72b8',
	red: '#c46a61',
}
const CANVAS_FONT = "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif"
const KIND_LABEL: Record<string, string> = { yellow: '主題', green: '待辦', blue: '決議', red: '風險' }
const KIND_ORDER = ['yellow', 'green', 'blue', 'red'] as const
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

const ACCENT = '#b4530a'
// lighten a #rrggbb toward white (for the soft top of the sticky gradient)
function lighten(hex: string, amt = 0.16): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex)
	if (!m) return hex
	const n = parseInt(m[1], 16)
	const r = Math.min(255, ((n >> 16) & 255) + Math.round(255 * amt))
	const g = Math.min(255, ((n >> 8) & 255) + Math.round(255 * amt))
	const b = Math.min(255, (n & 255) + Math.round(255 * amt))
	return `rgb(${r},${g},${b})`
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
	const [filter, setFilter] = useState<{ type: 'tag' | 'owner'; value: string } | null>(null)
	const [connectMode, setConnectMode] = useState(false)
	const [connectFrom, setConnectFrom] = useState<string | null>(null)
	const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
	const [agentText, setAgentText] = useState('') // manual-transcript draft (local only, not synced)
	const [showPaste, setShowPaste] = useState(false) // the paste-transcript option is hidden by default
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
	const [guide, setGuide] = useState(() => !localStorage.getItem('wb-seen-guide')) // first-run onboarding

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
	function tidy() {
		fetch(`${SYNC_HTTP}/api/rooms/${encodeURIComponent(room)}/tidy`, { method: 'POST' }).catch(() => {})
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

	// re-render once the web fonts load so Konva re-measures canvas text crisply
	const [, setFontReady] = useState(false)
	useEffect(() => {
		;(document as any).fonts?.ready.then(() => setFontReady(true))
	}, [])

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
	const matchesFilter = (s: Sticky) =>
		!filter ||
		(filter.type === 'tag' ? (s.tags || []).includes(filter.value) : s.owner === filter.value || s.drawnBy === filter.value)

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

	// react to an agent response: a recognised voice command (apply view + show
	// label) or normal content (show how many cards it made)
	function applyAgentResponse(r: any, prefix = '') {
		if (!r || !r.ok) {
			setBusy(r?.error ? `錯誤:${r.error}` : '錯誤')
			return
		}
		if (r.intent === 'command') {
			const c = r.command
			if (c?.action === 'filter') setFilter({ type: c.by === 'tag' ? 'tag' : 'owner', value: c.value })
			else if (c?.action === 'clearFilter') setFilter(null)
			setBusy(`指令:${r.commandLabel || '已執行'}`)
		} else {
			setBusy(`${prefix}+${r.added?.length ?? r.stickies ?? 0} 張、+${r.connectors ?? 0} 連線`)
		}
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
			applyAgentResponse(r)
		} catch (e) {
			setBusy(`錯誤:${(e as Error).message}`)
		}
	}

	// voice: mic -> /api/voice -> ear -> agent -> board
	const recRef = useRef<MediaRecorder | null>(null)
	const [recording, setRecording] = useState(false)

	// dictate a single card's text by voice (from the per-card popover)
	const [cardRecId, setCardRecId] = useState<string | null>(null)
	const cardRecRef = useRef<MediaRecorder | null>(null)
	async function dictateCard(id: string) {
		if (cardRecId === id) {
			cardRecRef.current?.stop()
			return
		}
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
			setBusy('麥克風被瀏覽器擋:要 localhost 或 HTTPS')
			return
		}
		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		} catch (e) {
			setBusy(`麥克風錯誤:${(e as any)?.name || (e as Error).message}`)
			return
		}
		const chunks: BlobPart[] = []
		const mr = new MediaRecorder(stream)
		mr.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
		mr.onstop = async () => {
			stream.getTracks().forEach((t) => t.stop())
			setCardRecId(null)
			const type = mr.mimeType || 'audio/webm'
			const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'
			setBusy('轉錄中…')
			try {
				const r = await fetch(`${SYNC_HTTP}/api/transcribe?ext=${ext}`, {
					method: 'POST',
					headers: { 'Content-Type': type },
					body: new Blob(chunks, { type }),
				}).then((x) => x.json())
				if (r.ok && r.text) {
					patchShape(id, { text: r.text })
					setBusy('')
				} else setBusy(r.error ? `錯誤:${r.error}` : '沒聽到內容')
			} catch (e) {
				setBusy(`錯誤:${(e as Error).message}`)
			}
		}
		cardRecRef.current = mr
		mr.start()
		setCardRecId(id)
		setBusy('講出這張卡的內容…再按一次停止')
	}

	// continuous "meeting" mode: keep listening, auto-cut a segment on each pause
	// (silence) and send it for transcription+agent, so cards appear hands-free.
	const [meeting, setMeeting] = useState(false)
	const [segCount, setSegCount] = useState(0)
	const meetingRef = useRef<{ stop: () => void } | null>(null)

	function sendSegment(blob: Blob) {
		if (!blob.size) return
		const type = blob.type || 'audio/webm'
		const ext = type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'
		setSegCount((c) => c + 1)
		fetch(`${SYNC_HTTP}/api/voice/${encodeURIComponent(room)}?ext=${ext}&by=${encodeURIComponent(me.name)}`, {
			method: 'POST',
			headers: { 'Content-Type': type },
			body: blob,
		})
			.then((x) => x.json())
			.then((r) => applyAgentResponse(r)) // a segment may be a spoken command, not content
			.catch(() => {})
	}

	async function startMeeting() {
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
			setBusy(`麥克風被瀏覽器擋:此頁是 ${location.protocol}//${location.host},要 localhost 或 HTTPS。`)
			return
		}
		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		} catch (e) {
			setBusy(`麥克風錯誤:${(e as any)?.name || (e as Error).message}`)
			return
		}
		setMeeting(true)
		setSegCount(0)
		setBusy('會議記錄中…講一段、停頓一下就會自動整理上板')

		const ctx = new AudioContext()
		const analyser = ctx.createAnalyser()
		analyser.fftSize = 1024
		ctx.createMediaStreamSource(stream).connect(analyser)
		const buf = new Uint8Array(analyser.fftSize)

		const SPEAK = 0.018 // RMS threshold for "speech"
		const SILENCE_MS = 1200 // pause length that ends a segment
		const MIN_MS = 1500 // ignore ultra-short blips
		const MAX_MS = 25000 // force a cut on long monologues

		let mr: MediaRecorder | null = null
		let chunks: BlobPart[] = []
		let segStart = 0
		let spoke = false
		let silentSince = 0
		let alive = true

		const startSeg = () => {
			chunks = []
			mr = new MediaRecorder(stream)
			mr.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
			mr.onstop = () => sendSegment(new Blob(chunks, { type: mr?.mimeType || 'audio/webm' }))
			mr.start()
			segStart = performance.now()
			spoke = false
			silentSince = 0
		}
		const cut = () => {
			try {
				if (mr && mr.state !== 'inactive') mr.stop() // onstop sends this segment
			} catch {}
			if (alive) startSeg()
		}
		const iv = setInterval(() => {
			if (!alive) return
			analyser.getByteTimeDomainData(buf)
			let sum = 0
			for (let i = 0; i < buf.length; i++) {
				const v = (buf[i] - 128) / 128
				sum += v * v
			}
			const rms = Math.sqrt(sum / buf.length)
			const now = performance.now()
			if (rms > SPEAK) {
				spoke = true
				silentSince = 0
			} else if (spoke && !silentSince) {
				silentSince = now
			}
			const dur = now - segStart
			if ((spoke && silentSince && now - silentSince > SILENCE_MS && dur > MIN_MS) || (spoke && dur > MAX_MS)) cut()
		}, 120)

		meetingRef.current = {
			stop: () => {
				alive = false
				clearInterval(iv)
				try {
					if (mr && mr.state !== 'inactive') mr.stop() // flush final segment
				} catch {}
				stream.getTracks().forEach((t) => t.stop())
				ctx.close().catch(() => {})
				setMeeting(false)
				setBusy('會議記錄結束')
			},
		}
		startSeg()
	}
	function stopMeeting() {
		meetingRef.current?.stop()
	}
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
				applyAgentResponse(r, r.transcript ? `聽到「${r.transcript}」→ ` : '')
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
	// bare <button> is styled globally (index.html); keep this empty so variant
	// overrides (background, width…) layer on top cleanly.
	const btn: React.CSSProperties = {}

	// exposed for verification / console poking
	;(window as any).__wb = {
		addSticky,
		patchShape,
		deleteSticky,
		addConnector,
		clearAll,
		cmd: async (t: string) =>
			applyAgentResponse(
				await fetch(`${SYNC_HTTP}/api/agent/${encodeURIComponent(room)}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ transcript: t, by: me.name }),
				}).then((x) => x.json())
			),
	}
	;(window as any).__cursors = cursors

	return (
		<div className="board-bg" style={{ position: 'fixed', inset: 0 }}>
			{/* first-run onboarding / help */}
			{guide && (
				<div
					style={{
						position: 'fixed',
						inset: 0,
						zIndex: 4000,
						background: 'rgba(28,26,23,0.5)',
						backdropFilter: 'blur(4px)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: 16,
					}}
				>
					<div
						className="glass modal-in"
						style={{ background: 'rgba(253,251,247,0.98)', width: 'min(440px, 92vw)', maxHeight: '88vh', overflowY: 'auto', padding: '26px 24px 20px', borderRadius: 20 }}
					>
						<div className="code" style={{ fontSize: 30, color: 'var(--ink)' }}>共筆白板</div>
						<div style={{ color: 'var(--ink-soft)', fontSize: 14, margin: '2px 0 18px' }}>開會時邊講,AI 幫你把重點整理成白板</div>
						{(
							[
								['開始開會', '按左下「● 開始會議記錄」,正常講話 —— 停頓一下,AI 就把那段重點整理成便利貼。也可把逐字稿貼進面板按「丟給 agent」。'],
								['用講的下指令', '錄音中直接說「幫我排一下」「只看亞澤的」「把這張指給小明」「改成決議」,AI 會分辨那是指令、自動幫你執行,不用去找按鈕。'],
							['顏色 = 類型', '__LEGEND__'],
								['自己調整', '雙擊空白新增便利貼、雙擊卡片改字、拖拉移動;點一張卡可改色或刪除;「連線」把兩張卡的關係連起來。'],
								['拉人一起', '右上「分享 / QR」—— 同事掃 QR 或輸入房號就進來,大家即時一起編輯。'],
								['收尾', '按「會議摘要」,AI 一鍵產出一頁會議紀錄(決議 / 待辦 / 風險)。'],
							] as [string, string][]
						).map(([t, d], i) => (
							<div key={i} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
								<div style={{ flex: '0 0 24px', height: 24, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600 }}>
									{i + 1}
								</div>
								<div style={{ flex: 1 }}>
									<div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{t}</div>
									{d === '__LEGEND__' ? (
										<div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, color: 'var(--ink-soft)' }}>
											{KIND_ORDER.map((c) => (
												<span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
													<span style={{ width: 13, height: 13, borderRadius: 4, background: COLORS[c], display: 'inline-block' }} />
													{KIND_LABEL[c]}
												</span>
											))}
										</div>
									) : (
										<div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.55 }}>{d}</div>
									)}
								</div>
							</div>
						))}
						<button
							style={{ width: '100%', marginTop: 6, padding: '11px', fontSize: 15, fontWeight: 600, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
							onClick={() => {
								localStorage.setItem('wb-seen-guide', '1')
								setGuide(false)
							}}
						>
							開始使用
						</button>
					</div>
				</div>
			)}
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
								stroke={sel ? ACCENT : 'rgba(28,26,23,0.4)'}
								fill={sel ? ACCENT : 'rgba(28,26,23,0.4)'}
								strokeWidth={sel ? 3.5 : 2}
								hitStrokeWidth={16}
								pointerLength={10}
								pointerWidth={10}
								tension={0}
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
								opacity={matchesFilter(s) ? 1 : 0.16} onDragStart={() => setSelectedId(s.id)}
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
									cornerRadius={16}
									fillLinearGradientStartPoint={{ x: 0, y: 0 }}
									fillLinearGradientEndPoint={{ x: 0, y: s.h }}
									fillLinearGradientColorStops={[0, lighten(COLORS[s.color] ?? s.color), 1, COLORS[s.color] ?? s.color]}
									shadowColor="#1c1a17"
									shadowOpacity={selected ? 0.28 : 0.17}
									shadowBlur={selected ? 26 : 18}
									shadowOffsetY={selected ? 12 : 8}
									stroke={pending ? ACCENT : selected ? '#1c1a17' : 'rgba(255,255,255,0.45)'}
									strokeWidth={pending ? 3 : selected ? 2 : 1}
								/>
								{/* kind accent dot */}
								<Circle x={18} y={18} radius={5} fill={KIND_ACCENT[s.color] ?? '#1c1a17'} opacity={0.8} />
								<Text
									text={s.text}
									width={s.w}
									height={s.h}
									padding={20}
									fontSize={19}
									lineHeight={1.25}
									fontFamily={CANVAS_FONT}
									fontStyle="500"
									fill="#1f1c18"
									align="center"
									verticalAlign="middle"
								/>
								{/* content tags (top row) — click to filter by tag */}
								{(() => {
									let tx = 32
									return (s.tags || []).slice(0, 2).map((t, i) => {
										const w = t.length * 11 + 12
										const x = tx
										tx += w + 5
										return (
											<Group
												key={'tag' + i}
												x={x}
												y={9}
												onClick={(e: any) => { e.cancelBubble = true; setFilter({ type: 'tag', value: t }) }}
												onTap={(e: any) => { e.cancelBubble = true; setFilter({ type: 'tag', value: t }) }}
											>
												<Rect width={w} height={17} cornerRadius={8} fill="rgba(28,26,23,0.1)" />
												<Text x={6} y={3} text={t} fontSize={10.5} fontFamily={CANVAS_FONT} fill="rgba(28,26,23,0.6)" />
											</Group>
										)
									})
								})()}
								{/* person: owner(負責人) or drawnBy(誰提的) — click to filter by person */}
								{(() => {
									const person = s.owner || (s.drawnBy && s.drawnBy !== 'user' ? s.drawnBy : null)
									if (!person) return null
									const w = Math.min(person.length * 12 + 18, s.w - 24)
									return (
										<Group
											x={12}
											y={s.h - 27}
											onClick={(e: any) => { e.cancelBubble = true; setFilter({ type: 'owner', value: person }) }}
											onTap={(e: any) => { e.cancelBubble = true; setFilter({ type: 'owner', value: person }) }}
										>
											<Rect width={w} height={19} cornerRadius={9.5} fill={s.owner ? 'rgba(180,83,10,0.18)' : 'rgba(28,26,23,0.1)'} />
											<Text x={9} y={3.5} text={person} fontSize={11} fontFamily={CANVAS_FONT} fontStyle={s.owner ? '600' : 'normal'} fill={s.owner ? '#8a3f08' : 'rgba(28,26,23,0.6)'} />
										</Group>
									)
								})()}
							</Group>
						)
					})}
					{/* live cursors of everyone else (Mori + other humans) */}
					{cursors.map((c) => (
						<Group key={c.id} x={c.x} y={c.y} listening={false}>
							<Circle radius={7} fill={c.color} stroke="#fff" strokeWidth={2} shadowColor="#1c1a17" shadowOpacity={0.25} shadowBlur={6} shadowOffsetY={2} />
							<Rect
								x={11}
								y={-10}
								width={c.name.length * 8.5 + 16}
								height={20}
								cornerRadius={10}
								fill={c.color}
								shadowColor="#1c1a17"
								shadowOpacity={0.2}
								shadowBlur={6}
								shadowOffsetY={2}
							/>
							<Text x={19} y={-6} text={c.name} fontSize={12} fontFamily={CANVAS_FONT} fontStyle="600" fill="#fff" />
						</Group>
					))}
				</Layer>
			</Stage>

			{/* elegant empty state */}
			{shapes.length === 0 && (
				<div
					style={{
						position: 'fixed',
						inset: 0,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						pointerEvents: 'none',
						zIndex: 1,
						textAlign: 'center',
						gap: 8,
					}}
				>
					<div className="code" style={{ fontSize: 38, color: 'var(--ink)', opacity: 0.9 }}>共筆白板</div>
					<div style={{ fontSize: 15, color: 'var(--ink-soft)' }}>按左下「● 開始會議記錄」,邊講邊整理上板</div>
					<div style={{ fontSize: 13, color: 'var(--ink-soft)', opacity: 0.75 }}>
						或雙擊空白新增便利貼 · 右上「分享 / QR」拉人進來
					</div>
				</div>
			)}

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
			<div className="glass float-in" style={bar}>
				<span style={{ color: 'var(--ink-soft)', fontSize: 12 }}>房號</span>
				<span className="code" style={{ fontSize: 19, color: 'var(--accent)', marginRight: 2 }}>{room}</span>
				<button
					title="分享這間會議室:QR、房號、邀請連結"
					style={{ background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}
					onClick={() => setShareOpen(true)}
				>
					分享 / QR
				</button>
				<span style={{ color: 'var(--ink-soft)', fontSize: 12 }} title={status === 'synced' ? '已即時連線' : status}>
					{status === 'synced' ? '已連線' : status} · {shapes.length} 張
				</span>
				<button title="新增一張空白便利貼(也可雙擊白板空白處)" style={btn} onClick={() => addSticky(140, 140, '', 'yellow') && undefined}>
					＋ 便利貼
				</button>
				<button
					title="開啟後,依序點兩張便利貼,畫出一條關係箭頭"
					style={{ ...btn, ...(connectMode ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
					onClick={() => {
						setConnectMode((v) => !v)
						setConnectFrom(null)
					}}
				>
					{connectMode ? '連線中:點兩張' : '連線'}
				</button>
				<button style={btn} title="復原 Ctrl+Z" onClick={() => undoMgr.undo()}>
					↶
				</button>
				<button style={btn} title="重做 Ctrl+Shift+Z" onClick={() => undoMgr.redo()}>
					↷
				</button>
				<button
					style={btn}
					title="刪除目前選取的便利貼或連線(快捷鍵 Delete)"
					onClick={() => {
						if (selectedId) deleteSticky(selectedId)
						else if (selectedConnId) deleteConnector(selectedConnId)
					}}
				>
					刪除選取
				</button>
				<button
					title="用 AI 把整張板整理成一頁會議紀錄(重點/決議/待辦/風險)"
					style={{ ...btn, background: '#fef3c7' }}
					onClick={() => window.open(`${SYNC_HTTP}/api/summary/${encodeURIComponent(room)}`, '_blank')}
				>
					會議摘要
				</button>
				<button style={btn} title="下載 markdown 會議紀錄" onClick={exportMd}>
					匯出 MD
				</button>
				<button style={btn} title="下載白板圖片 (PNG)" onClick={exportPng}>
					匯出 PNG
				</button>
				<button
					title="自動把便利貼按類型分欄排整齊(主題/待辦/決議/風險各一欄)"
					style={{ ...btn, background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' }}
					onClick={tidy}
				>
					自動排列
				</button>
				<button style={btn} title="視圖回到原點與原始縮放" onClick={() => setView({ x: 0, y: 0, scale: 1 })}>
					回正
				</button>
				<button
					style={btn}
					title="清空整個房間(會清掉所有人的板,請小心)"
					onClick={() => {
						if (window.confirm('清空整個房間給所有人?')) clearAll()
					}}
				>
					清空
				</button>
				<button style={btn} title="使用說明 / 新手引導" onClick={() => setGuide(true)}>
					?
				</button>
			</div>

			{/* contextual color + delete popover for a selected sticky */}
			{selectedId &&
				byId(selectedId) &&
				(() => {
					const s = byId(selectedId)!
					const left = Math.max(8, Math.min(view.x + s.x * view.scale, size.w - 230))
					const top = Math.max(8, view.y + s.y * view.scale - 48)
					return (
						<div
							className="glass float-in"
							style={{ position: 'fixed', left, top, zIndex: 1500, display: 'flex', gap: 7, alignItems: 'center', padding: '5px 9px' }}
						>
							<span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>改色</span>
							{KIND_ORDER.map((c) => (
								<button
									key={c}
									title={KIND_LABEL[c]}
									onClick={() => patchShape(selectedId, { color: c })}
									style={{
										width: 22,
										height: 22,
										padding: 0,
										borderRadius: '50%',
										background: COLORS[c],
										border: s.color === c ? '2px solid var(--ink)' : '2px solid #fff',
										boxShadow: '0 1px 3px rgba(28,26,23,0.25)',
									}}
								/>
							))}
							<button
								title="用語音輸入這張卡的內容(再按一次停止)"
								className={cardRecId === selectedId ? 'live' : undefined}
								style={{
									padding: '4px 9px',
									background: cardRecId === selectedId ? 'var(--live)' : undefined,
									color: cardRecId === selectedId ? '#fff' : undefined,
									borderColor: cardRecId === selectedId ? 'var(--live)' : undefined,
								}}
								onClick={() => dictateCard(selectedId)}
							>
								{cardRecId === selectedId ? '■ 停止' : '● 語音'}
							</button>
							<button
								title="刪除這張 (Delete)"
								style={{ color: '#b91c1c', padding: '4px 9px' }}
								onClick={() => {
									deleteSticky(selectedId)
									setSelectedId(null)
								}}
							>
								刪除
							</button>
						</div>
					)
				})()}

			{/* filter bar — only show cards of a tag/person */}
			{filter && (
				<div
					className="glass float-in"
					style={{ position: 'fixed', bottom: 40, left: '50%', transform: 'translateX(-50%)', zIndex: 1400, display: 'flex', gap: 8, alignItems: 'center', padding: '6px 12px', fontSize: 13 }}
				>
					<span>只看 {filter.type === 'tag' ? '#' + filter.value : filter.value}</span>
					<button style={{ padding: '3px 9px' }} onClick={() => setFilter(null)}>
						顯示全部 ✕
					</button>
				</div>
			)}

			{/* hint (desktop only) */}
			{!mobile && (
				<div style={hint}>
					雙擊空白新增 · 雙擊改字 · 拖拉移動 · 點便利貼/連線後 Delete 刪除 · Ctrl+Z 復原 · 空白拖曳平移 · 滾輪縮放
				</div>
			)}

			{/* agent / voice panel (collapsible; record stays visible) */}
			<div className="glass float-in" style={{ ...panel, width: mobile ? 'min(86vw, 320px)' : 320, left: mobile ? 8 : 14 }}>
				<div
					onClick={() => setPanelOpen((o) => !o)}
					style={{ fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
				>
					{panelOpen ? '▾' : '▸'} 開會記錄
				</div>
				{/* voice = the main way to get content onto the board */}
				<button
					className={meeting ? 'live' : undefined}
					style={{
						width: '100%',
						marginTop: 8,
						fontSize: 15,
						padding: '12px',
						fontWeight: 600,
						background: meeting ? 'var(--live)' : 'var(--ink)',
						color: '#fff',
						borderColor: meeting ? 'var(--live)' : 'var(--ink)',
					}}
					title="連續錄音:邊講邊整理,停頓會自動斷句上板;再按一次停止"
					onClick={() => (meeting ? stopMeeting() : startMeeting())}
				>
					{meeting ? `■ 停止會議記錄（已整理 ${segCount} 段）` : '● 開始會議記錄'}
				</button>
				{panelOpen && (
					<>
						<button
							style={{ ...btn, width: '100%', marginTop: 6, fontSize: 12, background: recording ? '#fecaca' : '#f3f4f6' }}
							title="只錄一段:按開始、講話、再按停止"
							onClick={toggleRecord}
							disabled={meeting}
						>
							{recording ? '■ 停止' : '單次錄一段'}
						</button>
						{/* manual transcript = secondary, hidden until you ask for it */}
						<div style={{ marginTop: 8, fontSize: 12 }}>
							<span onClick={() => setShowPaste((v) => !v)} style={{ cursor: 'pointer', color: 'var(--accent)' }}>
								{showPaste ? '收起貼逐字稿' : '或:貼現成的逐字稿 ▸'}
							</span>
						</div>
						{showPaste && (
							<>
								<textarea
									value={agentText}
									onChange={(e) => setAgentText(e.target.value)}
									placeholder="把現成的會議逐字稿貼進來,按下面轉成便利貼(這格只給你自己看,不會同步給別人)"
									style={{ width: '100%', height: 70, fontSize: 12, resize: 'vertical', boxSizing: 'border-box', marginTop: 6 }}
								/>
								<button title="把上面這段逐字稿交給 AI,整理成彩色便利貼" style={{ ...btn, width: '100%', marginTop: 6 }} onClick={runAgent}>
									丟給 agent
								</button>
							</>
						)}
					</>
				)}
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
						className="modal-in" onClick={(e) => e.stopPropagation()}
						style={{
							background: 'rgba(253,251,247,0.98)',
							borderRadius: 18,
							padding: 24,
							width: 320,
							textAlign: 'center',
							boxShadow: '0 24px 60px -20px rgba(28,26,23,0.45)',
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
						<div className="code" style={{ fontSize: 52, color: 'var(--accent)', margin: '6px 0 16px', lineHeight: 1 }}>{room}</div>
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

// these get className="glass" for the frosted look; consts hold position/layout only
const bar: React.CSSProperties = {
	position: 'fixed',
	top: 14,
	left: '50%',
	transform: 'translateX(-50%)',
	zIndex: 1000,
	display: 'flex',
	flexWrap: 'wrap',
	justifyContent: 'center',
	maxWidth: '94vw',
	gap: 6,
	alignItems: 'center',
	padding: '7px 12px',
	fontSize: 13,
}
const hint: React.CSSProperties = {
	position: 'fixed',
	bottom: 10,
	left: '50%',
	transform: 'translateX(-50%)',
	zIndex: 1000,
	color: 'var(--ink-soft)',
	fontSize: 12,
}
const panel: React.CSSProperties = {
	position: 'fixed',
	left: 14,
	bottom: 38,
	zIndex: 1000,
	padding: 12,
	fontSize: 13,
}
