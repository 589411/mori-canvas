import { createRoot } from 'react-dom/client'
import App from './App'

// NOTE: no <StrictMode>. In dev, StrictMode double-invokes effects (mount →
// cleanup → mount); our cleanup calls provider.destroy(), which would tear down
// the yjs WebSocket connection right after it connects. Single mount keeps the
// provider alive for the spike.
createRoot(document.getElementById('root')!).render(<App />)
