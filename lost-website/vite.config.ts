import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn/ui components import from "@/…"
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // 5173 belongs to the plug-in's own UI dev server; keep the two able to run together.
  server: { port: 5174, strictPort: true },
});
