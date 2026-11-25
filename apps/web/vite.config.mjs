import { defineConfig } from "vite";
export default defineConfig({
  build: {
    outDir: "../../dist/web", emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "app.js", assetFileNames: "app.[ext]" } },
  },
  esbuild: { jsx: "automatic" },
});
