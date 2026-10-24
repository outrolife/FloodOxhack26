import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The app reads /data/*.json from web/public/data/. When a file is missing,
// src/data.ts falls back to the matching sample in ../tests/fixtures/, which is
// bundled at build time via import.meta.glob. The dev server must be allowed
// to read that folder, hence fs.allow includes the repo root.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // One bundle on purpose: tabs switch instantly during the demo, offline.
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    // Live mode: `make api` serves FastAPI on :8000.
    proxy: { "/api": "http://localhost:8000" },
  },
});
