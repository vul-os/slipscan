/**
 * jsdom shims for browser APIs the app uses at module scope.
 *
 * Kept to the minimum: anything stubbed here is a real API the tests are no
 * longer exercising, so the list should stay short and each entry should say
 * why jsdom cannot provide it.
 */

// theme.svelte.ts calls this in its constructor (module-scope singleton), and
// jsdom ships no CSS media-query engine.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
