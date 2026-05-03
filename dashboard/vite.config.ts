import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "100.104.140.85",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "100.104.140.85",
    port: 4173,
    strictPort: true,
  },
});
