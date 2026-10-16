import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:7870" } },
  build: {
    outDir: "../src/marcostudio/web",
    emptyOutDir: true,
    sourcemap: false,
  },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
});
