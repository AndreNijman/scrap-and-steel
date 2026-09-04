import { defineConfig } from "vite";

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
});
