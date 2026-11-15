import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../chat-api/public and served by chat-api (no CDN at runtime). In dev, /api goes to a
// local chat-api (DEV_USER set) on :8080.
export default defineConfig({
	plugins: [react()],
	base: "./",
	build: { outDir: "../chat-api/public", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
	server: { proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } } },
});
