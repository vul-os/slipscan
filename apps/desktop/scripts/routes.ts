/**
 * The one place a capture script learns what the app's screens are.
 *
 * Both screenshotters used to restate the route list inline, and both went
 * stale: `household` and `packs` shipped as real screens while the gallery
 * captured nine and the QA sweep captured nine different ones. Nothing failed,
 * because a hardcoded array cannot notice that it is wrong.
 *
 * src/lib/state/router.svelte.ts is the authority — the nav renders from it and a
 * test pins the sidebar to the same order — so it is parsed rather than
 * mirrored. A renamed or removed route now throws here instead of silently
 * dropping a screen out of the captures.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTER = join(appDir, "src", "lib", "state", "router.svelte.ts");

/** Every route id, in sidebar order. */
export function readRoutes(): string[] {
  const text = readFileSync(ROUTER, "utf8");
  const block = text.match(/export const ROUTES = \[([\s\S]*?)\] as const;/);
  if (!block) {
    throw new Error(`could not find "export const ROUTES" in ${ROUTER}`);
  }
  const routes = [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  if (routes.length === 0) throw new Error(`no routes parsed from ${ROUTER}`);
  return routes;
}
