import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Shopify App Bridge requires this for embedded apps
declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

// Standard Shopify dev integration: the CLI launches this web process with PORT,
// SHOPIFY_APP_URL (the tunnel) and FRONTEND_PORT set, and proxies the embedded app
// to PORT. Do NOT hardcode the port — it must match what the CLI assigns, or the
// CLI proxy forwards to the wrong port and the app times out / shows "Invalid path /".
const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;
const hmrConfig =
  host === "localhost"
    ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 }
    : { protocol: "wss", host, port: Number(process.env.FRONTEND_PORT) || 8002, clientPort: 443 };

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_singleFetch: true,
        v3_lazyRouteDiscovery: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  server: {
    port: Number(process.env.PORT || 3000),
    cors: true,
    allowedHosts: true,
    hmr: hmrConfig,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}) satisfies UserConfig;
