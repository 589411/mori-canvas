// Mori Canvas service worker — network-FIRST so an update is never stale while online;
// cached shell only as an offline fallback. /api + /sync always go straight to network
// (realtime collab + STT must never be cached). Not registered inside the Tauri app.
const CACHE = 'mori-canvas-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icons/mori-128.png', '/icons/mori-256.png', '/icons/mori-512.png']

self.addEventListener('install', (e) => {
	self.skipWaiting()
	e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})))
})
self.addEventListener('activate', (e) => {
	e.waitUntil(
		(async () => {
			const keys = await caches.keys()
			await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
			await self.clients.claim()
		})()
	)
})
self.addEventListener('fetch', (e) => {
	const req = e.request
	if (req.method !== 'GET') return
	const url = new URL(req.url)
	if (url.pathname.startsWith('/api') || url.pathname.startsWith('/sync')) return // never cache live endpoints
	e.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok && url.origin === location.origin) {
					const copy = res.clone()
					caches.open(CACHE).then((c) => c.put(req, copy))
				}
				return res
			})
			.catch(() => caches.match(req).then((m) => m || caches.match('/')))
	)
})
