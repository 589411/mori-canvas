import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'

// The sync server stays on loopback; Vite is the single exposed origin and
// reverse-proxies the API and the websocket to it. So http(s)://<host>:5174 is
// all anyone needs — and over HTTPS the phone gets a secure context (mic works).
const SYNC = 'http://127.0.0.1:1234'
const useHttps = process.env.HTTPS === '1' && existsSync('certs/key.pem') && existsSync('certs/cert.pem')

export default defineConfig({
	root: 'client',
	plugins: [react()],
	server: {
		port: 5174,
		host: true,
		https: useHttps
			? { key: readFileSync('certs/key.pem'), cert: readFileSync('certs/cert.pem') }
			: undefined,
		proxy: {
			'/api': { target: SYNC, changeOrigin: true },
			// /sync/<room> -> ws://127.0.0.1:1234/sync/<room> (server strips the "sync/" prefix)
			'/sync': { target: SYNC.replace('http', 'ws'), ws: true, changeOrigin: true },
		},
	},
})
