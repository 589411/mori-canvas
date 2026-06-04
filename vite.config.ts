import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
	root: 'client',
	plugins: [react()],
	server: { port: 5174, host: true },
})
