import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite is now build-only: it produces client/dist, which the Rust server embeds
// (include_dir) and serves alongside /api + /sync on one port. No dev server / proxy.
export default defineConfig({
	root: 'client',
	plugins: [react()],
})
