import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Build outputs land in dist-<mode>/ so each Cloudflare Pages project (dev /
// main) deploys the right artifact. Local `vite` (dev server) and `vite build`
// (default) keep using `dist/`.
export default defineConfig(({ mode }) => {
  const outDir = mode === "dev" || mode === "main" ? `dist-${mode}` : "dist";
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      // Fixed port so slipscan can run alongside other local projects without
      // collisions. strictPort makes Vite fail loudly instead of silently
      // grabbing a neighbour's port.
      port: 5175,
      strictPort: true,
      watch: {
        ignored: [
          "**/.claude/worktrees/**",
          "**/dist/**",
          "**/dist-*/**",
          "**/backend/**",
          "**/.git/**",
          "**/node_modules/**",
        ],
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
    },
  };
});
