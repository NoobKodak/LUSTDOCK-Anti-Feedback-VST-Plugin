import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  // The Figma exports live outside the UI folder and are shared with the C++ build.
  publicDir: "../assets",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // BinaryData needs a file list that is known at CMake configure time.
        entryFileNames: "app.js",
        chunkFileNames: "app.js",
        assetFileNames: "app.[ext]",
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
