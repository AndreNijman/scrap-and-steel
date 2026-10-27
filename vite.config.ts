import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          planck: ["planck-js"],
        },
      },
    },
  },
  server: {
    port: 5180,
  },
  test: {
    // runs against wrangler dev: node tests/latency/rooms.test.mjs
    exclude: [...configDefaults.exclude, "tests/latency/rooms.test.mjs"],
  },
});
