/**
 * First-run setup — the gate, the persistence, the step machine, and the
 * dialog itself.
 *
 * The properties that matter here are mostly *negative*: it must not appear
 * for an existing user, must not appear twice, must not appear when
 * `book_list` failed (a transport error is not an empty install), and must
 * never wedge the app. Those are all invisible in a screenshot, so they are
 * the bulk of what is asserted.
 *
 * Region and currency are checked against the region-profile *data* the mock
 * serves, never against literals — "regions are data, not code" is a
 * contract, and a test that hardcoded "ZA" would quietly permit breaking it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import FirstRun from "../lib/components/FirstRun.svelte";
import { mockApi } from "../lib/api/mock";
import {
  FIRST_RUN_KEY,
  FIRST_RUN_STEPS,
  currencyForRegion,
  currencyOptions,
  firstRun,
  isCurrencyCode,
  loadRecord,
  nextStep,
  prevStep,
  saveRecord,
  shouldRunFirstRun,
  stepIssue,
  stepNumber,
  type FirstRunRecord,
  type FirstRunStep,
} from "../lib/onboarding.svelte";
import type { RegionInfo } from "../lib/api/types";

const FRESH: FirstRunRecord = {
  dismissed: false,
  completed: false,
  region: null,
  currency: null,
  at: null,
};

/** A storage that is present but hostile — private mode, quota, a locked
 * WebView. None of it may decide whether the app runs. */
function brokenStorage() {
  return {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
}

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("first-run gate", () => {
  it("appears only when there is no book at all", () => {
    expect(shouldRunFirstRun(0, FRESH)).toBe(true);
    expect(shouldRunFirstRun(1, FRESH)).toBe(false);
    expect(shouldRunFirstRun(7, FRESH)).toBe(false);
  });

  it("stays away once it has been dismissed", () => {
    expect(shouldRunFirstRun(0, { ...FRESH, dismissed: true })).toBe(false);
    expect(shouldRunFirstRun(0, { ...FRESH, dismissed: true, completed: true }))
      .toBe(false);
  });

  it("treats 'we could not tell' as 'do not interrupt'", () => {
    // A failed book_list is not an empty install. Greeting an existing user
    // with a setup wizard because IPC hiccuped would be the worse failure.
    expect(shouldRunFirstRun(null, FRESH)).toBe(false);
  });
});

describe("first-run persistence", () => {
  it("round-trips a decision", () => {
    const storage = memoryStorage();
    const record: FirstRunRecord = {
      dismissed: true,
      completed: true,
      region: "za",
      currency: "ZAR",
      at: "2026-07-28T09:00:00.000Z",
    };
    saveRecord(record, storage);
    expect(loadRecord(storage)).toEqual(record);
  });

  it("reads a missing, corrupt or wrongly-typed entry as fresh", () => {
    expect(loadRecord(memoryStorage())).toEqual(FRESH);
    expect(loadRecord(memoryStorage({ [FIRST_RUN_KEY]: "{not json" }))).toEqual(
      FRESH,
    );
    expect(
      loadRecord(
        memoryStorage({
          [FIRST_RUN_KEY]: JSON.stringify({ dismissed: "yes", region: 42 }),
        }),
      ),
    ).toEqual(FRESH);
  });

  it("survives storage that throws, in both directions", () => {
    const storage = brokenStorage();
    expect(() => loadRecord(storage)).not.toThrow();
    expect(loadRecord(storage)).toEqual(FRESH);
    expect(() => saveRecord({ ...FRESH, dismissed: true }, storage)).not.toThrow();
    expect(() => loadRecord(null)).not.toThrow();
    expect(() => saveRecord(FRESH, null)).not.toThrow();
  });
});

describe("first-run steps", () => {
  it("clamps at both ends instead of walking off the list", () => {
    expect(prevStep("welcome")).toBe("welcome");
    expect(nextStep("done")).toBe("done");
    expect(stepNumber("welcome")).toBe(1);
    expect(stepNumber("done")).toBe(FIRST_RUN_STEPS.length);
  });

  it("walks forwards and backwards over every step", () => {
    let step: FirstRunStep = FIRST_RUN_STEPS[0]!;
    const forwards: FirstRunStep[] = [step];
    for (let i = 1; i < FIRST_RUN_STEPS.length; i++) {
      step = nextStep(step);
      forwards.push(step);
    }
    expect(forwards).toEqual([...FIRST_RUN_STEPS]);
    const backwards: FirstRunStep[] = [step];
    for (let i = 1; i < FIRST_RUN_STEPS.length; i++) {
      step = prevStep(step);
      backwards.push(step);
    }
    expect(backwards).toEqual([...FIRST_RUN_STEPS].reverse());
  });

  it("only the region step can hold the flow up, and it says why", () => {
    for (const step of FIRST_RUN_STEPS) {
      if (step === "region") continue;
      expect(stepIssue(step, { region: null, currency: "" })).toBeNull();
    }
    expect(stepIssue("region", { region: null, currency: "ZAR" })).toMatch(
      /region profile/i,
    );
    expect(stepIssue("region", { region: "za", currency: "" })).toMatch(
      /three-letter/i,
    );
    expect(stepIssue("region", { region: "za", currency: "Z" })).toContain("Z");
    expect(stepIssue("region", { region: "za", currency: "ZAR" })).toBeNull();
    expect(stepIssue("region", { region: "za", currency: " zar " })).toBeNull();
  });
});

describe("region and currency come from the profile data", () => {
  const regions: RegionInfo[] = [
    {
      id: "generic",
      display_name: "Generic",
      country: null,
      default_currency: null,
      tax_report_name: "Tax summary",
    },
    {
      id: "pt",
      display_name: "Portugal",
      country: "PT",
      default_currency: "EUR",
      tax_report_name: "IVA",
    },
    {
      id: "za",
      display_name: "South Africa",
      country: "ZA",
      default_currency: "ZAR",
      tax_report_name: "VAT201",
    },
  ];

  it("takes the currency from the chosen profile, and nothing else", () => {
    expect(currencyForRegion(regions, "pt")).toBe("EUR");
    expect(currencyForRegion(regions, "za")).toBe("ZAR");
    expect(currencyForRegion(regions, null)).toBeNull();
    expect(currencyForRegion(regions, "unknown")).toBeNull();
    // A profile with no currency must yield none — not a substituted guess.
    expect(currencyForRegion(regions, "generic")).toBeNull();
  });

  it("suggests only currencies the installed profiles actually name", () => {
    expect(currencyOptions(regions)).toEqual(["EUR", "ZAR"]);
    expect(currencyOptions([])).toEqual([]);
  });

  it("accepts any three-letter code, so no jurisdiction is privileged", () => {
    for (const code of ["ZAR", "eur", "JpY", "BHD"]) {
      expect(isCurrencyCode(code)).toBe(true);
    }
    for (const code of ["", "ZA", "ZARR", "Z1R", "R"]) {
      expect(isCurrencyCode(code)).toBe(false);
    }
  });
});

describe("first-run controller", () => {
  beforeEach(() => {
    localStorage.removeItem(FIRST_RUN_KEY);
    firstRun.open = false;
    firstRun.step = "welcome";
    firstRun.region = null;
    firstRun.currency = "";
  });

  afterEach(() => {
    firstRun.open = false;
    localStorage.removeItem(FIRST_RUN_KEY);
  });

  it("opens on an empty install and stays shut otherwise", async () => {
    // A dismissed record is read at construction, so this needs a fresh
    // module instance rather than a mutated singleton.
    vi.resetModules();
    localStorage.setItem(
      FIRST_RUN_KEY,
      JSON.stringify({ dismissed: true, completed: false }),
    );
    const dismissed = await import("../lib/onboarding.svelte");
    dismissed.firstRun.consider(0);
    expect(dismissed.firstRun.open).toBe(false);

    vi.resetModules();
    localStorage.removeItem(FIRST_RUN_KEY);
    const fresh = await import("../lib/onboarding.svelte");
    fresh.firstRun.consider(1);
    expect(fresh.firstRun.open).toBe(false);
    fresh.firstRun.consider(0);
    expect(fresh.firstRun.open).toBe(true);
    fresh.firstRun.dismiss();
    expect(fresh.firstRun.open).toBe(false);
    // Dismissal is remembered, so it does not come back on the next boot.
    expect(loadRecord().dismissed).toBe(true);
    localStorage.removeItem(FIRST_RUN_KEY);
  });

  it("adopts the region's currency, but never overwrites a typed one", () => {
    const regions: RegionInfo[] = [
      {
        id: "za",
        display_name: "South Africa",
        country: "ZA",
        default_currency: "ZAR",
        tax_report_name: "VAT201",
      },
      {
        id: "pt",
        display_name: "Portugal",
        country: "PT",
        default_currency: "EUR",
        tax_report_name: "IVA",
      },
    ];

    firstRun.chooseRegion("za", regions);
    expect(firstRun.currency).toBe("ZAR");
    // Switching region while the currency is still the old default follows.
    firstRun.chooseRegion("pt", regions);
    expect(firstRun.currency).toBe("EUR");
    // Once the user has typed their own, changing region must not clobber it.
    firstRun.currency = "GBP";
    firstRun.chooseRegion("za", regions);
    expect(firstRun.currency).toBe("GBP");
  });

  it("will not advance past a step it cannot validate", () => {
    firstRun.step = "region";
    firstRun.region = null;
    firstRun.currency = "";
    expect(firstRun.issue).not.toBeNull();
    firstRun.advance();
    expect(firstRun.step).toBe("region");

    firstRun.region = "za";
    firstRun.currency = "ZAR";
    expect(firstRun.issue).toBeNull();
    firstRun.advance();
    expect(firstRun.step).toBe("data");
    firstRun.retreat();
    expect(firstRun.step).toBe("region");
  });

  it("records the choices, upper-cased, on both skip and finish", () => {
    firstRun.region = "za";
    firstRun.currency = " zar ";
    firstRun.finish();
    const finished = loadRecord();
    expect(finished).toMatchObject({
      dismissed: true,
      completed: true,
      region: "za",
      currency: "ZAR",
    });
    expect(finished.at).not.toBeNull();

    localStorage.removeItem(FIRST_RUN_KEY);
    firstRun.currency = "";
    firstRun.dismiss();
    expect(loadRecord()).toMatchObject({
      dismissed: true,
      completed: false,
      currency: null,
    });
  });
});

// ---------------------------------------------------------------------------
// the dialog itself
// ---------------------------------------------------------------------------

function render(component: Component): {
  target: HTMLElement;
  dispose: () => void;
} {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target });
  return {
    target,
    dispose: () => {
      unmount(instance);
      target.remove();
    },
  };
}

async function tick(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

const flat = (el: Element | null) =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("first-run dialog", () => {
  let fatal: string[] = [];
  const onError = (e: ErrorEvent) => fatal.push(e.message);

  beforeEach(() => {
    fatal = [];
    window.addEventListener("error", onError);
    localStorage.removeItem(FIRST_RUN_KEY);
    firstRun.open = false;
    firstRun.step = "welcome";
    firstRun.region = null;
    firstRun.currency = "";
  });

  afterEach(() => {
    window.removeEventListener("error", onError);
    firstRun.open = false;
    localStorage.removeItem(FIRST_RUN_KEY);
    document.body.innerHTML = "";
  });

  it("renders nothing at all until it is opened", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      await tick();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("offers exactly the region profiles the backend serves", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      firstRun.open = true;
      await tick();

      firstRun.step = "region";
      await tick();

      const radios = [...document.querySelectorAll('[role="radio"]')];
      const served = await mockApi.region_list();
      expect(radios).toHaveLength(served.length);
      for (const region of served) {
        expect(flat(document.querySelector('[role="dialog"]'))).toContain(
          region.display_name,
        );
        // The profile's own tax-report name, straight from the data.
        expect(flat(document.querySelector('[role="dialog"]'))).toContain(
          region.tax_report_name,
        );
      }
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("picking a region fills in that profile's currency", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      firstRun.open = true;
      firstRun.step = "region";
      await tick();

      const served = await mockApi.region_list();
      const withCurrency = served.find((r) => r.default_currency)!;
      const radios = [...document.querySelectorAll('[role="radio"]')];
      const index = served.indexOf(withCurrency);
      (radios[index] as HTMLElement).click();
      await tick();

      expect(firstRun.region).toBe(withCurrency.id);
      expect(firstRun.currency).toBe(withCurrency.default_currency);
      expect(radios[index]!.getAttribute("aria-checked")).toBe("true");
      expect(firstRun.issue).toBeNull();
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("says out loud what it does not do, rather than implying it does", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      firstRun.open = true;
      firstRun.step = "region";
      await tick();
      // The book it cannot create.
      expect(flat(document.querySelector('[role="dialog"]'))).toContain(
        "book_create",
      );

      firstRun.step = "mailbox";
      await tick();
      // The e-mail parsing that is not built.
      expect(flat(document.querySelector('[role="dialog"]'))).toMatch(
        /not (built|implemented)/i,
      );
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("is skippable from the very first step, and remembers it", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      firstRun.open = true;
      await tick();

      const skip = [...document.querySelectorAll("button")].find((b) =>
        flat(b).includes("Skip setup"),
      )!;
      expect(skip, "no way out of the first step").toBeDefined();
      skip.click();
      await tick();

      expect(firstRun.open).toBe(false);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(loadRecord().dismissed).toBe(true);
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("Escape dismisses it too — it never holds the app hostage", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      firstRun.open = true;
      await tick();

      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      flushSync();
      await tick();

      expect(firstRun.open).toBe(false);
      expect(loadRecord().dismissed).toBe(true);
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("names every step in the progress bar, with one current", async () => {
    const { dispose } = render(FirstRun as Component);
    try {
      firstRun.open = true;
      firstRun.step = "data";
      await tick();

      const steps = [...document.querySelectorAll('ol[aria-label] li')];
      expect(steps).toHaveLength(FIRST_RUN_STEPS.length);
      expect(
        steps.filter((s) => s.getAttribute("aria-current") === "step"),
      ).toHaveLength(1);
      expect(flat(document.querySelector('[role="dialog"]'))).toContain(
        `Step ${stepNumber("data")} of ${FIRST_RUN_STEPS.length}`,
      );
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});
