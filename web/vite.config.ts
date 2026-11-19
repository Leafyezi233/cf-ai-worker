import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "recharts-vendor": ["recharts"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/v1": "http://localhost:8787",
      "/console": {
        target: "http://127.0.0.1:8787",
        bypass(req) {
          if (req.headers.accept?.includes("text/html") && /^\/console\/?$/.test(req.url || "")) return req.url;
        },
      },
    },
  },
});