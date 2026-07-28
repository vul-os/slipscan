/**
 * "The set of books changed" — a single reactive tick, nothing more.
 *
 * Creating the first book is the one mutation that invalidates *everything*
 * already on screen: every route load, and the session cache behind them,
 * ran against a database that had no book. The sidebar had nothing to name
 * and each screen was in its no-book state. Nothing short of re-running
 * those loads is correct afterwards.
 *
 * So this is deliberately coarse: bump it and the shell drops the route
 * cache and remounts the current screen. It is not a store of books — the
 * screens still fetch their own — it is only the signal that they must.
 */
import { routeCache } from "./loadCache";

class BookEpoch {
  /** Incremented on every book creation; part of the shell's remount key. */
  value = $state(0);

  /**
   * A book was created. Drops the stale-while-revalidate cache first, so the
   * remount cannot render a screen's pre-book snapshot for a frame before
   * the refresh lands.
   */
  bump(): void {
    routeCache.clear();
    this.value += 1;
  }
}

export const bookEpoch = new BookEpoch();
