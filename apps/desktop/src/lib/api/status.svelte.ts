/**
 * Reactive API-transport status. Lives in its own `.svelte.ts` module so the
 * plain-TS client can flip the flag while components react to it.
 */

export const apiStatus = $state({
  /**
   * True once any call has fallen back to mock data while running under
   * Tauri (i.e. a command is not wired into src-tauri). The sidebar surfaces
   * this so fabricated data is never mistaken for real data.
   */
  usedMockFallback: false,
});
