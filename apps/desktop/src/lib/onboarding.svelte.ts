/**
 * First-run setup: state, gating and persistence.
 *
 * WHY IT EXISTS: region, currency, the data folder and the mailbox were
 * discoverable only by hunting through Settings. A person opening SlipScan
 * for the first time had nothing telling them those choices were theirs to
 * make, or where they live.
 *
 * WHEN IT APPEARS: only when `book_list` comes back empty. That is the
 * honest definition of "nothing set up yet", and it is the one state where
 * the rest of the app has nothing to show anyway. It is skippable from every
 * step, Escape dismisses it, and dismissal is remembered — it never blocks
 * the app and never comes back on its own.
 *
 * WHAT IT DOES *NOT* DO, and says so on screen (contract: honest caveats are
 * a feature, never quietly upgraded):
 *   - It does not create a book. `book_create` exists in slipscan-core but is
 *     not exposed as a Tauri command, so no screen can call it. Under Tauri
 *     the backend seeds a first book itself (src-tauri `ensure_seeded`), so
 *     the way to *get* a book here is to point SlipScan at a data folder —
 *     which is wired, and is what the data step does.
 *   - It does not enable bank-alert-email parsing. That is not built. The
 *     mailbox step records nothing and only points at where the IMAP details
 *     live.
 *
 * The region and currency the user picks are recorded locally as a stated
 * preference. They are not written to a book, because there is no book and
 * no command that would accept them.
 */

import type { RegionInfo } from "./api/types";

export const FIRST_RUN_STEPS = [
  "welcome",
  "region",
  "data",
  "mailbox",
  "done",
] as const;

export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export interface FirstRunRecord {
  /** The user closed or skipped it; never offer it again unprompted. */
  dismissed: boolean;
  /** They walked to the end rather than skipping out. */
  completed: boolean;
  /** Region profile id from `region_list` — never a hardcoded jurisdiction. */
  region: string | null;
  /** ISO-4217 code they intend to keep books in. */
  currency: string | null;
  /** ISO-8601 UTC of the decision, for support questions. */
  at: string | null;
}

export const FIRST_RUN_KEY = "slipscan.firstRun";

const EMPTY: FirstRunRecord = {
  dismissed: false,
  completed: false,
  region: null,
  currency: null,
  at: null,
};

/** Storage may be unavailable (private mode, a hardened WebView). Never let
 * that decide whether the app runs — an unreadable record reads as "fresh". */
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadRecord(storage: Storage | null = defaultStorage()): FirstRunRecord {
  if (!storage) return { ...EMPTY };
  let raw: string | null = null;
  try {
    raw = storage.getItem(FIRST_RUN_KEY);
  } catch {
    return { ...EMPTY };
  }
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<FirstRunRecord>;
    return {
      dismissed: parsed.dismissed === true,
      completed: parsed.completed === true,
      region: typeof parsed.region === "string" ? parsed.region : null,
      currency: typeof parsed.currency === "string" ? parsed.currency : null,
      at: typeof parsed.at === "string" ? parsed.at : null,
    };
  } catch {
    // Corrupt entry: treat as fresh rather than throwing on boot.
    return { ...EMPTY };
  }
}

export function saveRecord(
  record: FirstRunRecord,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(FIRST_RUN_KEY, JSON.stringify(record));
  } catch {
    // Nothing to do and nothing worth interrupting the user over.
  }
}

/**
 * Show first-run setup? Only with no books at all, and only if the user has
 * not already dismissed it. A failed `book_list` is *not* an empty one — the
 * caller passes `null` for "we could not tell", and we stay out of the way.
 */
export function shouldRunFirstRun(
  bookCount: number | null,
  record: FirstRunRecord,
): boolean {
  if (bookCount === null) return false;
  if (record.dismissed) return false;
  return bookCount === 0;
}

export function nextStep(step: FirstRunStep): FirstRunStep {
  const i = FIRST_RUN_STEPS.indexOf(step);
  return FIRST_RUN_STEPS[Math.min(i + 1, FIRST_RUN_STEPS.length - 1)]!;
}

export function prevStep(step: FirstRunStep): FirstRunStep {
  const i = FIRST_RUN_STEPS.indexOf(step);
  return FIRST_RUN_STEPS[Math.max(i - 1, 0)]!;
}

/** 1-based position, for "Step 2 of 5". */
export function stepNumber(step: FirstRunStep): number {
  return FIRST_RUN_STEPS.indexOf(step) + 1;
}

// ---------------------------------------------------------------------------
// region & currency — from the region-profile data, never hardcoded
// ---------------------------------------------------------------------------

/** ISO-4217 codes are three letters. Nothing else is accepted. */
export function isCurrencyCode(value: string): boolean {
  return /^[A-Za-z]{3}$/.test(value.trim());
}

/**
 * The currency a region profile implies. `null` when the profile does not
 * name one (the generic profile may not), which is exactly when the user
 * has to say — so the caller must not substitute a guess.
 */
export function currencyForRegion(
  regions: RegionInfo[],
  regionId: string | null,
): string | null {
  if (!regionId) return null;
  return regions.find((r) => r.id === regionId)?.default_currency ?? null;
}

/** Every currency any installed region profile names, deduped and sorted. */
export function currencyOptions(regions: RegionInfo[]): string[] {
  const seen = new Set<string>();
  for (const region of regions) {
    if (region.default_currency) seen.add(region.default_currency.toUpperCase());
  }
  return [...seen].sort();
}

export interface FirstRunChoices {
  region: string | null;
  currency: string;
}

/**
 * Why the current step cannot be left yet, or null. A *reason*, not a
 * boolean, so the flow can say it rather than greying a button out silently.
 */
export function stepIssue(
  step: FirstRunStep,
  choices: FirstRunChoices,
): string | null {
  if (step !== "region") return null;
  if (!choices.region) return "Choose a region profile to continue.";
  if (choices.currency.trim() === "")
    return "Enter the three-letter currency code you keep books in.";
  if (!isCurrencyCode(choices.currency))
    return `“${choices.currency.trim()}” is not a three-letter ISO-4217 code.`;
  return null;
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

class FirstRun {
  /** The dialog is on screen. */
  open = $state(false);
  step = $state<FirstRunStep>("welcome");
  region = $state<string | null>(null);
  currency = $state("");

  #record: FirstRunRecord = loadRecord();

  get record(): FirstRunRecord {
    return { ...this.#record };
  }

  readonly choices: FirstRunChoices = $derived({
    region: this.region,
    currency: this.currency,
  });

  readonly issue: string | null = $derived(stepIssue(this.step, this.choices));

  /** Called once `book_list` resolves. Opens the flow only if it should. */
  consider(bookCount: number | null): void {
    if (shouldRunFirstRun(bookCount, this.#record)) {
      this.step = "welcome";
      this.region = this.#record.region;
      this.currency = this.#record.currency ?? "";
      this.open = true;
    }
  }

  /** Adopt the region's currency unless the user has typed their own. */
  chooseRegion(regionId: string, regions: RegionInfo[]): void {
    const previousDefault = currencyForRegion(regions, this.region);
    const untouched = this.currency === "" || this.currency === previousDefault;
    this.region = regionId;
    if (untouched) this.currency = currencyForRegion(regions, regionId) ?? "";
  }

  advance(): void {
    if (this.issue) return;
    this.step = nextStep(this.step);
  }

  retreat(): void {
    this.step = prevStep(this.step);
  }

  /** Escape, the backdrop, or "Skip setup" — remembered, never re-offered. */
  dismiss(): void {
    this.#persist({ dismissed: true, completed: false });
    this.open = false;
  }

  /** Reached the end. Same persistence, flagged as a completion. */
  finish(): void {
    this.#persist({ dismissed: true, completed: true });
    this.open = false;
  }

  /**
   * Re-open on demand. The seam for a "run setup again" control in Settings;
   * nothing calls it yet, which is why the flow's closing copy does not
   * promise one.
   */
  reopen(): void {
    this.step = "welcome";
    this.region = this.#record.region;
    this.currency = this.#record.currency ?? "";
    this.open = true;
  }

  #persist(flags: { dismissed: boolean; completed: boolean }): void {
    this.#record = {
      ...flags,
      region: this.region,
      currency: this.currency.trim() ? this.currency.trim().toUpperCase() : null,
      at: new Date().toISOString(),
    };
    saveRecord(this.#record);
  }
}

export const firstRun = new FirstRun();
