import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * Component-level test config, deliberately separate from vite.config.ts:
 * the app config pins port 1420 and loads Tailwind, neither of which a jsdom
 * run needs. Tests mount real route components against the in-memory mock
 * dataset (src/lib/api/mock.ts), so nothing here talks to a backend.
 */
export default defineConfig({
  plugins: [svelte()],
  // Vitest resolves Node conditions by default; Svelte's client runtime (and
  // its `mount`) only exists under the browser condition.
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    // Vitest stubs every `.css` import to an empty string by default, which
    // also swallows `?raw`. The token audit (src/__tests__/tokens.test.ts)
    // reads app.css as text to measure its contrast, so raw CSS has to come
    // through. Nothing under test imports a stylesheet for its side effects,
    // so this changes nothing else.
    css: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
    restoreMocks: true,
  },
});
