import { defineConfig } from "vite";

// Build output lands inside the Go package that embeds it, so a single
// `make build` produces a one-binary distributable.
export default defineConfig({
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
