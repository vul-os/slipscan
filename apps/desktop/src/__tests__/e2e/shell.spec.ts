// Shell behaviour that only a real browser can prove.
//
// The jsdom suites (palette.test.ts, components.test.ts) cover the state
// machine, the ARIA wiring and where focus lands. None of them can see a
// layout engine, so none of them can tell you whether the focus ring is
// actually drawn, whether the rail really collapses at the `rail`
// breakpoint, or whether `prefers-reduced-motion` reaches the animations.
// That is what this covers.
//
// No backend: outside Tauri the client serves every call from the in-memory
// mock dataset, the same property the render-smoke spec relies on.

import { expect, test, type Page } from "@playwright/test";

/** The `rail` breakpoint in app.css is 56.25rem = 900px. */
const RAIL_BREAKPOINT = 900;

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

async function open(page: Page, route = "dashboard"): Promise<void> {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(`/#/${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
    null,
    { timeout: 15_000 },
  );
}

test.describe("command palette", () => {
  test("Ctrl-K opens it, typing filters it, Enter navigates", async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The combobox holds focus the whole time — the highlighted row is
    // communicated through aria-activedescendant, never by moving focus.
    const input = page.getByRole("combobox");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-expanded", "true");

    await input.fill("reconcile");
    const options = page.getByRole("option");
    await expect(options.first()).toContainText("Reconcile");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/#\/reconcile$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Reconcile",
    );
  });

  test("arrow keys move the selection and keep exactly one selected", async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox");
    await expect(input).toBeFocused();

    const first = await input.getAttribute("aria-activedescendant");
    await page.keyboard.press("ArrowDown");
    const second = await input.getAttribute("aria-activedescendant");
    expect(second).not.toBe(first);
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(
      1,
    );

    // Wrapping: up from the top lands on the last row, not on nothing.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(
      1,
    );
  });

  test("Escape closes it and hands focus back to the trigger", async ({
    page,
  }) => {
    await open(page);
    const trigger = page.locator("#palette-trigger");
    await trigger.focus();
    await trigger.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("runs an action and lands the keyboard in the new screen", async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("import a receipt");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/#\/receipts$/);
    // Not <body>: a keyboard user must be able to carry on from here.
    await expect(page.locator("#main")).toBeFocused();
  });

  test("Tab cannot walk out of it into the screen behind", async ({ page }) => {
    // Worth proving in a browser specifically: the trap's "is this element
    // reachable" question is a layout question, and jsdom has no layout.
    await open(page);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    for (const key of ["Tab", "Tab", "Shift+Tab", "Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        return !!panel && panel.contains(document.activeElement);
      });
      expect(inside, `focus escaped the palette after ${key}`).toBe(true);
    }
  });

  test("the G-then-letter chord still works alongside it", async ({ page }) => {
    await open(page);
    await page.keyboard.press("g");
    await page.keyboard.press("b");
    await expect(page).toHaveURL(/#\/budgets$/);
  });
});

test.describe("the rail collapses", () => {
  test("hides labels below the breakpoint and keeps every screen reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await open(page);

    const links = page.locator("nav a");
    // Eleven, not sixteen: the five Trade destinations (contacts, catalogue,
    // stock, purchasing, sales) carry a `requires` profile flag and the demo
    // book is personal, so the rail genuinely does not render them. This
    // number tracks what a PERSONAL book shows — it is not ROUTES.length and
    // should not be "corrected" to it.
    await expect(links).toHaveCount(11);
    await expect(links.first()).toContainText("Dashboard");

    await page.setViewportSize({ width: RAIL_BREAKPOINT - 100, height: 900 });
    // Same eleven destinations, now icon-only — collapsed must not mean
    // "some screens are unreachable".
    await expect(links).toHaveCount(11);
    const railWidth = await page
      .locator("aside")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(railWidth).toBeLessThan(80);

    // Each one still carries its name for the pointer and for assistive tech.
    await expect(links.first()).toHaveAttribute("title", "Dashboard");
    // …and the palette is still there, as an icon.
    await expect(page.locator("#palette-trigger")).toBeVisible();
    await expect(page.locator("#palette-trigger")).toHaveAttribute(
      "aria-label",
      /search|jump/i,
    );
  });
});

/** One sampled tab stop's focus-ring computed style, or the fields used to name it. */
interface FocusStop {
  id: string;
  href: string | null;
  name: string;
  width: string;
  style: string;
  offset: string;
  color: string;
}

test.describe("accessibility of the shell", () => {
  // The ring colour is the lime family, and it is a *different* lime per
  // theme (the raw accent is unreadable on white). Both are checked against
  // the token, not against "some outline exists".
  const RING: Record<"light" | "dark", string> = {
    light: "rgb(92, 117, 0)",
    dark: "rgb(200, 255, 0)",
  };

  // One test per theme, deliberately not a loop inside one test: a hash-only
  // `goto` does not reload the document, so a second pass would carry on
  // tabbing from wherever the first left off rather than starting over.
  for (const scheme of ["light", "dark"] as const) {
    test(`draws the branded focus ring on every shell control · ${scheme}`, async ({
      page,
    }) => {
      // Reduced motion is emulated so the assertion is about the ring at
      // rest. Controls carrying `transition-colors` transition
      // `outline-color` too, so reading the computed style the instant after
      // focus otherwise catches the start of that 120ms fade — which is
      // `currentColor`, not the token.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await open(page);

      // Walk the real tab order rather than focusing elements by hand:
      // `:focus-visible` is a *keyboard* state, and the ring is only owed on
      // controls a keyboard actually reaches.
      const stops: FocusStop[] = [];
      for (let i = 0; i < 13; i++) {
        await page.keyboard.press("Tab");
        const stop = await page.evaluate<FocusStop | null>(async () => {
          // Let the ring settle before sampling it. Controls carrying
          // `transition-colors` transition `outline-color` as well, so an
          // immediate read catches the start of that fade — which is
          // `currentColor`, not the token. 200ms clears the 120ms
          // `--dur-quick` this uses.
          await new Promise((resolve) => setTimeout(resolve, 200));
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const style = getComputedStyle(el);
          return {
            id: el.id,
            href: el.getAttribute("href"),
            name: (el.getAttribute("aria-label") ?? el.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 40),
            width: style.outlineWidth,
            style: style.outlineStyle,
            offset: style.outlineOffset,
            color: style.outlineColor,
          };
        });
        if (!stop) throw new Error(`tab stop ${i} landed on nothing focusable`);
        stops.push(stop);
      }

      // Focus order: the escape hatch first, then the palette, then the
      // rail's destinations in rail order.
      expect(stops[0].name).toBe("Skip to content");
      expect(stops[1].id).toBe("palette-trigger");
      // The five Trade destinations are absent on purpose: they carry a
      // `requires` profile flag and the demo book is personal, so the rail
      // does not render them and they cannot be in the tab order either.
      expect(stops.slice(2).map((s) => s.href)).toEqual([
        "#/dashboard",
        "#/transactions",
        "#/receipts",
        "#/budgets",
        "#/household",
        "#/ledger",
        "#/reconcile",
        "#/payments",
        "#/reports",
        "#/packs",
        "#/settings",
      ]);

      // Every stop, not just the first: the palette trigger used to lose its
      // ring entirely by borrowing the text field's styling, and only a
      // check this wide would have caught it.
      for (const stop of stops) {
        const where = stop.name || stop.href || "(unnamed stop)";
        expect(stop.style, where).toBe("solid");
        expect(stop.width, where).toBe("2px");
        expect(stop.offset, where).toBe("2px");
        expect(stop.color, where).toBe(RING[scheme]);
      }
    });
  }

  test("the skip link is the first stop and jumps to the content", async ({
    page,
  }) => {
    await open(page, "transactions");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("button", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("honours prefers-reduced-motion for the overlays", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();

    // app.css collapses every animation to a single frame under reduce; the
    // scrim and the panel are no exception.
    const durations = await page.evaluate<Array<string | null>>(() =>
      [".scrim", ".dialog-panel"].map((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).animationDuration : null;
      }),
    );
    for (const duration of durations) {
      // `0.01ms !important`, as the browser computes it — a single frame.
      // A missing element (duration === null) still has to fail this
      // assertion rather than vanish from the loop.
      expect(Number.parseFloat(String(duration))).toBeLessThan(0.001);
    }
  });

  test("the palette is a modal dialog with an accessible name", async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    // getByRole with a name resolves the accessible name for real, through
    // aria-labelledby — which is the thing a screen reader will announce.
    await expect(
      page.getByRole("dialog", { name: /command palette/i }),
    ).toHaveCount(1);
  });
});
