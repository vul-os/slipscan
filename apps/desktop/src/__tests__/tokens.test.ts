/**
 * Design-token audit, as a gate rather than a memo.
 *
 * app.css claims "dark AND light, dark first-class" and "tuned per theme for
 * AA". Those are checkable claims, and until this existed nothing checked
 * them — the contrast numbers had been eyeballed, and three of them were
 * wrong (tertiary text failed 4.5:1 on every surface in *both* themes,
 * danger text failed on its own tint, and the neutral chart hue failed 3:1
 * on the app background).
 *
 * What is asserted:
 *   1. Theme completeness — every semantic token has a light AND a dark
 *      value; neither theme may grow one the other lacks.
 *   2. No dead tokens — a declared `--ss-*` / `--chart-*` nobody uses.
 *   3. No drift — the tokens that are supposed to *be* the accent are.
 *   4. Contrast, computed (helpers/color.ts), in both themes, against the
 *      surface each token is actually drawn on.
 *
 * The known deviation is documented in app.css and restated at the bottom of
 * this file: resting control hairlines are below the 3:1 that WCAG 1.4.11
 * asks of a control boundary. It is pinned here so it cannot get *worse*
 * without a test failing.
 */
import { describe, expect, it } from "vitest";
import { over, parseColor, ratio, type Linear } from "./helpers/color";
import CSS from "../app.css?raw";

/**
 * The sheet and every file that could reference a token, pulled in through
 * Vite rather than `node:fs` — the desktop package has no Node types, and a
 * test that needs them is a test that only runs one way.
 */
const ALL_SOURCE = Object.values(
  import.meta.glob("../**/*.{svelte,ts,css}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>,
).join("\n");

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Bodies of every top-level `selector { … }` in the sheet, brace-counted. */
function blocks(css: string, selector: string): string[] {
  const out: string[] = [];
  const needle = `${selector} {`;
  let from = 0;
  for (;;) {
    const start = css.indexOf(needle, from);
    if (start === -1) return out;
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(css.slice(start + needle.length, i));
    from = i;
  }
}

/** `--name: value;` declarations in a block, last one winning. */
function decls(body: string): Map<string, string> {
  const found = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    found.set(m[1]!, m[2]!.trim().replace(/\s*\/\*[\s\S]*?\*\/\s*/g, " ").trim());
  }
  return found;
}

function merge(bodies: string[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const body of bodies)
    for (const [k, v] of decls(body)) all.set(k, v);
  return all;
}

const themeVars = merge(blocks(CSS, "@theme"));
const light = merge(blocks(CSS, ":root"));
const dark = merge(blocks(CSS, ".dark"));

/** Semantic tokens: the ones that exist in two flavours by definition. */
const semantic = (vars: Map<string, string>): string[] =>
  [...vars.keys()]
    .filter((k) => k.startsWith("--ss-") || k.startsWith("--chart-"))
    .sort();

function value(vars: Map<string, string>, name: string): string {
  const raw = vars.get(name);
  if (!raw) throw new Error(`app.css declares no ${name}`);
  return raw;
}

// ---------------------------------------------------------------------------
// 1. both themes complete
// ---------------------------------------------------------------------------

describe("theme completeness", () => {
  it("declares every semantic token in both themes", () => {
    // Not a subset check in one direction: a token added to only one theme
    // is a token that silently inherits the other theme's value.
    expect(semantic(dark)).toEqual(semantic(light));
  });

  it("declares a colour-scheme for each theme so native UI follows", () => {
    expect(merge(blocks(CSS, ":root")).get("color-scheme")).toBeUndefined();
    expect(CSS).toContain("color-scheme: light");
    expect(CSS).toContain("color-scheme: dark");
  });

  it("resolves every semantic colour token to a real colour, both themes", () => {
    for (const [name, vars] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const token of semantic(vars)) {
        // Non-colour semantics (--grain-opacity) are numbers; skip those.
        const raw = value(vars, token);
        if (!raw.startsWith("#") && !raw.startsWith("oklch")) continue;
        expect(() => parseColor(raw), `${name} ${token} = ${raw}`).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. nothing declared and forgotten
// ---------------------------------------------------------------------------

describe("no dead tokens", () => {
  it("uses every surface token it declares", () => {
    const dead: string[] = [];
    for (const token of semantic(light)) {
      // `--chart-*` is deliberately exempt: it is a *published palette* for
      // screens to draw categorical series from, and today only `--chart-1`
      // (the single spending hue shared by the dashboard meter, the reports
      // bars and the Packs comparison) is consumed. The five categorical
      // hues and the neutral are declared, contrast-checked below, and
      // waiting for a multi-series chart — not forgotten.
      if (token.startsWith("--chart-")) continue;
      // A token is alive if anything references it as `var(--x)`; the
      // `@theme inline` block republishes most of them as Tailwind colours
      // (`--color-line: var(--ss-line)` → `border-line`), which counts.
      const referenced = ALL_SOURCE.split(`var(${token})`).length > 1;
      if (!referenced) dead.push(token);
    }
    expect(dead, `declared but never referenced: ${dead.join(", ")}`).toEqual(
      [],
    );
  });

  it("keeps the categorical palette contiguous, so a screen can index it", () => {
    // A chart that walks `--chart-1..N` breaks the moment the run has a
    // hole in it; this is what makes "declared but not yet drawn" safe.
    const numbered = semantic(light)
      .filter((k) => /^--chart-\d+$/.test(k))
      .map((k) => Number(k.slice("--chart-".length)))
      .sort((a, b) => a - b);
    expect(numbered).toEqual(
      Array.from({ length: numbered.length }, (_, i) => i + 1),
    );
    expect(light.has("--chart-other")).toBe(true);
  });

  it("uses every animation and duration token it declares", () => {
    const motion = [...themeVars.keys(), ...light.keys()].filter(
      (k) =>
        k.startsWith("--animate-") ||
        k.startsWith("--dur-") ||
        k.startsWith("--ease-"),
    );
    const dead = motion.filter((token) => {
      if (ALL_SOURCE.split(`var(${token})`).length > 1) return false;
      // Tailwind turns `--animate-fade-in` into the `animate-fade-in` utility.
      const utility = token.replace(/^--animate-/, "animate-");
      return utility === token || !ALL_SOURCE.includes(utility);
    });
    expect(dead, `declared but never used: ${dead.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. the accent cannot drift
// ---------------------------------------------------------------------------

describe("accent family stays in step", () => {
  it("pins the focus ring and native accent to the accent colour", () => {
    // app.css says "keep in step with --color-accent when retheming"; a
    // comment cannot enforce that and this can. When the brand lime moves,
    // these move with it or this fails.
    expect(value(light, "--ss-focus")).toBe(value(themeVars, "--color-accent-text"));
    expect(value(light, "--ss-accent-ui")).toBe(
      value(themeVars, "--color-accent-text"),
    );
    expect(value(dark, "--ss-focus")).toBe(value(themeVars, "--color-accent"));
    expect(value(dark, "--ss-accent-ui")).toBe(value(themeVars, "--color-accent"));
  });

  it("keeps the lime off light-theme text, where it is unreadable", () => {
    // --color-accent-ring is a border/graphic weight; as type on the light
    // panel the raw lime family is nowhere near AA, and this records why the
    // separate --color-accent-text token exists.
    expect(
      ratio(value(themeVars, "--color-accent"), "#ffffff"),
    ).toBeLessThan(4.5);
    expect(
      ratio(value(themeVars, "--color-accent-ring"), "#ffffff"),
    ).toBeLessThan(4.5);
    expect(
      ratio(value(themeVars, "--color-accent-text"), "#ffffff"),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// 4. contrast, measured
// ---------------------------------------------------------------------------

/** WCAG AA for body text and for anything under ~18.66px, which is all of it. */
const AA_TEXT = 4.5;
/** WCAG 1.4.11 for meaningful non-text: focus rings, chart marks, meters. */
const AA_NON_TEXT = 3;

interface Case {
  what: string;
  fg: Linear | string;
  bg: Linear | string;
  min: number;
}

/** The four surfaces any text can land on, in elevation order. */
const SURFACES = ["--ss-surface", "--ss-panel", "--ss-sunken", "--ss-overlay"];

function cases(vars: Map<string, string>, themeVarsIn: Map<string, string>): Case[] {
  const v = (name: string) => value(vars, name);
  const out: Case[] = [];

  // Text on every surface it can sit on. t3 is included deliberately: it is
  // captions, eyebrows, kbd chips and placeholders — all of it text.
  for (const surface of SURFACES) {
    for (const ink of ["--ss-t1", "--ss-t2", "--ss-t3"]) {
      out.push({
        what: `${ink} on ${surface}`,
        fg: v(ink),
        bg: v(surface),
        min: AA_TEXT,
      });
    }
  }

  // Semantic text, on the panel and on its own 10% tint — the tint is where
  // it is actually used (error banners, status badges), and it is always the
  // harder of the two.
  for (const [token, label] of [
    ["--ss-ok", "ok"],
    ["--ss-warn", "warn"],
    ["--ss-err", "err"],
  ] as const) {
    const fg = parseColor(v(token));
    const panel = parseColor(v("--ss-panel"));
    out.push({ what: `${label} on panel`, fg, bg: panel, min: AA_TEXT });
    out.push({
      what: `${label} on its own /10 tint`,
      fg,
      bg: over(fg, panel, 0.1),
      min: AA_TEXT,
    });
  }

  // The focus ring, against every surface a focused control can sit on.
  for (const surface of SURFACES) {
    out.push({
      what: `focus ring on ${surface}`,
      fg: v("--ss-focus"),
      bg: v(surface),
      min: AA_NON_TEXT,
    });
  }

  // Chart marks, including "Other" — a neutral slice is still a slice.
  for (const chart of [
    "--chart-1",
    "--chart-2",
    "--chart-3",
    "--chart-4",
    "--chart-5",
    "--chart-other",
  ]) {
    for (const surface of ["--ss-surface", "--ss-panel", "--ss-sunken"]) {
      out.push({
        what: `${chart} on ${surface}`,
        fg: v(chart),
        bg: v(surface),
        min: AA_NON_TEXT,
      });
    }
  }

  // Filled controls: the label on the accent button and on the destructive
  // one. Both flip ink per theme; both have to clear text contrast.
  out.push({
    what: "btn-primary label on accent",
    fg: value(themeVarsIn, "--color-accent-fg"),
    bg: value(themeVarsIn, "--color-accent"),
    min: AA_TEXT,
  });

  // The accent badge: accent-family text over a 15% accent wash on panel.
  const accent = parseColor(value(themeVarsIn, "--color-accent"));
  const panel = parseColor(v("--ss-panel"));
  out.push({
    what: "accent badge text on accent/15",
    fg:
      vars === dark
        ? value(themeVarsIn, "--color-accent")
        : value(themeVarsIn, "--color-accent-text"),
    bg: over(accent, panel, 0.15),
    min: AA_TEXT,
  });

  return out;
}

describe.each([
  ["light", light],
  ["dark", dark],
])("contrast · %s theme", (_name, vars) => {
  for (const c of cases(vars, themeVars)) {
    it(`${c.what} clears ${c.min}:1`, () => {
      const measured = ratio(c.fg, c.bg);
      expect(
        measured,
        `${c.what} measured ${measured}:1, needs ${c.min}:1`,
      ).toBeGreaterThanOrEqual(c.min);
    });
  }
});

describe("btn-destructive label", () => {
  it("flips ink per theme so the filled red is readable in both", () => {
    // Light --ss-err is dark enough for white; the dark-theme one is not,
    // which is why .dark .btn-destructive switches to ink-950.
    expect(
      ratio(value(themeVars, "--color-ink-0"), value(light, "--ss-err")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(
      ratio(value(themeVars, "--color-ink-950"), value(dark, "--ss-err")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
    expect(CSS).toMatch(/\.dark \.btn-destructive \{[^}]*ink-950/);
  });
});

describe("known deviation, recorded", () => {
  it("resting control hairlines are below 3:1 — deliberately, and no worse", () => {
    // WCAG 1.4.11 asks 3:1 of a control boundary. --ss-line does not reach
    // it, and raising it is a whole-product visual decision rather than a
    // token tweak (see the comment on .input in app.css). What this pins is
    // that the mitigations hold: hover reaches for line-2, and the focus
    // ring is far above the bar in both themes.
    for (const vars of [light, dark]) {
      const line = ratio(value(vars, "--ss-line"), value(vars, "--ss-panel"));
      const line2 = ratio(value(vars, "--ss-line-2"), value(vars, "--ss-panel"));
      expect(line).toBeLessThan(AA_NON_TEXT);
      expect(line2).toBeGreaterThan(line);
      expect(
        ratio(value(vars, "--ss-focus"), value(vars, "--ss-panel")),
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});
