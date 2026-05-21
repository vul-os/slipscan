import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    globals: true,
    // Only our own src/ tests — never sibling agent worktrees under .claude/.
    include: ["src/**/*.{test,spec}.{js,jsx}"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist*/**"],
  },
});
