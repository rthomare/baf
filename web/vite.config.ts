import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build output lands inside the Go package that embeds it, so a single
// `make build` produces a one-binary distributable.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../internal/webfs/dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    host: true,
  },
});
