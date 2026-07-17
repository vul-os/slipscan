/**
 * Session-scoped, in-memory cache of each screen's last successful load.
 *
 * Routes remount on every navigation (`{#key router.current}` in App.svelte),
 * so without memory every tab switch re-runs `load()` and flashes a skeleton
 * for a frame or two even when the IPC round-trip returns in milliseconds.
 * Screens seed themselves from this cache (rendering the previous data
 * instantly) and refresh in the background — stale-while-revalidate, scoped
 * to the app session. Nothing is persisted anywhere.
 */
const cache = new Map<string, unknown>();

export const routeCache = {
  get<T>(key: string): T | undefined {
    return cache.get(key) as T | undefined;
  },
  set<T>(key: string, value: T): void {
    cache.set(key, value);
  },
};

/**
 * SWR wrapper for `{#await}`-based screens.
 *
 * Returns the cached value synchronously when present (Svelte renders the
 * `:then` branch immediately for non-promises) and kicks off a background
 * refresh reported via `onRefresh`; without a cache entry it returns the
 * in-flight promise. A failed background refresh keeps showing the cached
 * data — the screens' explicit Retry paths surface hard failures.
 * Pass `fresh: true` to bypass the cached value (retry after an error,
 * reload after a mutation) while still populating the cache on success.
 */
export function swrLoad<T>(
  key: string,
  loader: () => Promise<T>,
  onRefresh: (value: T) => void,
  opts: { fresh?: boolean } = {},
): Promise<T> | T {
  const refresh = loader().then((value) => {
    cache.set(key, value);
    return value;
  });
  const cached = opts.fresh ? undefined : (cache.get(key) as T | undefined);
  if (cached !== undefined) {
    refresh.then(onRefresh).catch(() => {});
    return cached;
  }
  return refresh;
}
