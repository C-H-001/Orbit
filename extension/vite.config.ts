import { copyFileSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.resolve(extensionRoot, "../dist-extension");

function copyExtensionStatic(root: string, outDir: string): Plugin {
  return {
    name: "copy-extension-static",
    closeBundle() {
      copyFileSync(path.join(root, "manifest.json"), path.join(outDir, "manifest.json"));
      cpSync(path.join(root, "assets"), path.join(outDir, "icons"), { recursive: true });
    },
  };
}

export default defineConfig({
  root: extensionRoot,
  publicDir: false,
  plugins: [react(), tailwindcss(), copyExtensionStatic(extensionRoot, outputRoot)],
  build: {
    outDir: "../dist-extension",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: path.join(extensionRoot, "sidepanel.html"),
        "service-worker": path.join(extensionRoot, "src/service-worker.ts"),
      },
      output: {
        entryFileNames: "scripts/[name].js",
        chunkFileNames: "scripts/[name]-[hash].js",
      },
    },
  },
});
