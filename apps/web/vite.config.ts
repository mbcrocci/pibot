import { defineConfig } from "vite-plus";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const serverUrl = process.env.SERVER_URL ?? "http://localhost:8787";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
  server: {
    // Leading dot matches the domain and all subdomains (ngrok tunnels).
    allowedHosts: [".ngrok-free.app"],
    // The pi-durable backend (apps/server) owns everything under /api.
    proxy: {
      "/api": serverUrl,
    },
  },
});
