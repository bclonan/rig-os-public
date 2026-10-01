import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  root: "console",
  plugins: [vue()],
  build: { outDir: "../dist/console", emptyOutDir: false },
  server: { host: "127.0.0.1" },
});
