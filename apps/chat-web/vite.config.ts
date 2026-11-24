import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../chat-api/public and served by chat-api (no CDN at runtime). In dev, /api goes to a
// local chat-api (DEV_USER set) on :8080.
// A2UI (H61) is written against the zod 3 API. zod 3.x has a HIGH advisory (GHSA-mrhx-c7xc-m3w5),
// so the package is zod 4.6.7 and the bare "zod" import resolves to its bundled v3 API (zod/v3).
// Only A2UI imports zod in the portal.
export default defineConfig({
	plugins: [react()],
	resolve: { alias: [{ find: /^zod$/, replacement: "zod/v3" }] },
	base: "./",
	build: { outDir: "../chat-api/public", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
	server: { proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } } },
});
