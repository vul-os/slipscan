/**
 * Colour maths for the design-token audit.
 *
 * Not a runtime dependency — this exists so the token tests can *measure*
 * contrast rather than assert someone eyeballed it. It understands the two
 * notations app.css actually uses (`#rrggbb` and `oklch(L C H)`) plus alpha
 * compositing, because several tokens are translucent tints laid over a
 * known surface (`bg-success/10`, `--ss-hairline`).
 *
 * Lives under __tests__/helpers/ so vitest's `src/**\/__tests__/**\/*.test.ts`
 * include pattern does not collect it as a suite.
 */

/** Linear-light sRGB, 0..1 per channel. The space luminance is defined in. */
export interface Linear {
  r: number;
  g: number;
  b: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** sRGB transfer function, encoded 0..1 → linear 0..1 (IEC 61966-2-1). */
function toLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function parseHex(hex: string): Linear {
  let clean = hex.trim().replace("#", "");
  if (clean.length === 3)
    clean = clean
      .split("")
      .map((c) => c + c)
      .join("");
  if (clean.length !== 6 || /[^0-9a-fA-F]/.test(clean))
    throw new Error(`not a hex colour: ${JSON.stringify(hex)}`);
  return {
    r: toLinear(parseInt(clean.slice(0, 2), 16) / 255),
    g: toLinear(parseInt(clean.slice(2, 4), 16) / 255),
    b: toLinear(parseInt(clean.slice(4, 6), 16) / 255),
  };
}

/**
 * Oklch → linear sRGB (Björn Ottosson's matrices).
 *
 * Channels are clamped into gamut afterwards, which is what a browser
 * displays anyway; every oklch token in app.css is already in gamut.
 */
function parseOklch(css: string): Linear {
  const inner = css.slice(css.indexOf("(") + 1, css.lastIndexOf(")"));
  const [coords] = inner.split("/");
  const parts = (coords ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) throw new Error(`not an oklch colour: ${css}`);
  const num = (raw: string): number =>
    raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  const L = num(parts[0]!);
  const C = num(parts[1]!);
  const H = num(parts[2]!);
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Alpha of a colour literal (`oklch(… / 0.07)`), or 1 when opaque. */
export function alphaOf(css: string): number {
  const slash = css.indexOf("/");
  if (slash === -1 || !css.startsWith("oklch")) return 1;
  const raw = css.slice(slash + 1, css.lastIndexOf(")")).trim();
  return raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
}

/** `rgb(9, 9, 11)` — what a browser hands back from a computed style. */
function parseRgb(css: string): Linear {
  const inner = css.slice(css.indexOf("(") + 1, css.lastIndexOf(")"));
  const parts = inner
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN))
    throw new Error(`not an rgb colour: ${css}`);
  return {
    r: toLinear(clamp01(parts[0]! / 255)),
    g: toLinear(clamp01(parts[1]! / 255)),
    b: toLinear(clamp01(parts[2]! / 255)),
  };
}

/** Parse any colour literal app.css — or a computed style — can produce. */
export function parseColor(css: string): Linear {
  const value = css.trim();
  if (value.startsWith("#")) return parseHex(value);
  if (value.startsWith("oklch")) return parseOklch(value);
  if (value.startsWith("rgb")) return parseRgb(value);
  throw new Error(`unsupported colour notation: ${JSON.stringify(css)}`);
}

/** Source-over composite of `fg` at `alpha` onto opaque `bg`. */
export function over(fg: Linear, bg: Linear, alpha: number): Linear {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

/** WCAG 2.x relative luminance. */
export function luminance(c: Linear): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** WCAG 2.x contrast ratio, 1..21. Order-independent. */
export function contrast(a: Linear | string, b: Linear | string): number {
  const la = luminance(typeof a === "string" ? parseColor(a) : a);
  const lb = luminance(typeof b === "string" ? parseColor(b) : b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast rounded the way a report should quote it (two decimals). */
export function ratio(a: Linear | string, b: Linear | string): number {
  return Math.round(contrast(a, b) * 100) / 100;
}
