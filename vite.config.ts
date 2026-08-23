import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "apps/desktop",
  build: { outDir: "dist", emptyOutDir: true },
  clearScreen: false,
});

