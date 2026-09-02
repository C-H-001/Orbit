import path from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8443),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.ORBIT_API_PORT || "8787"}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8443),
  },
})
