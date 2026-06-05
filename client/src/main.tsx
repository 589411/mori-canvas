import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'

// NOTE: no <StrictMode>. In dev, StrictMode double-invokes effects (mount →
// cleanup → mount); our cleanup calls provider.destroy(), which would tear down
// the yjs WebSocket connection right after it connects. Single mount keeps the
// provider alive for the spike.
createRoot(document.getElementById('root')!).render(<App />)

// Offline shell + faster repeat loads — web only. NOT in the Tauri desktop app (it loads
// from an embedded loopback server; a SW there is pointless and only risks stale cache).
const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window
if (!isTauri && 'serviceWorker' in navigator) {
	window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
