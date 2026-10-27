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
    // run against wrangler dev: node tests/latency/rooms.test.mjs, node tests/devjoin/relay.test.mjs
    exclude: [...configDefaults.exclude, "tests/latency/rooms.test.mjs", "tests/devjoin/relay.test.mjs"],
  },
});
