import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

/**
 * Load NEXT_PUBLIC_* from .env / .env.local into the test process.
 *
 * Next.js does this itself at build time; vitest does not, and the live chain
 * test needs the deployed addresses that `deploy-local.mjs` /
 * `deploy-testnet.mjs` write into .env.local. Without this, that test would
 * skip even when a deployment is configured — a silent false pass.
 *
 * Only the NEXT_PUBLIC_ prefix is loaded, so a secret sitting in a local .env
 * is never pulled into the test environment.
 */
const env = loadEnv("test", fileURLToPath(new URL("./", import.meta.url)), "NEXT_PUBLIC_");

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["__tests__/**/*.test.{ts,tsx}"],
    env,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
});
