import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [
    cloudflare({
      configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
      remoteBindings: process.env.DH_REMOTE_MODELS === "1",
    }),
  ],
  server: { host: "127.0.0.1", port: 5173 },
});
