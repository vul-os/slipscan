/**
 * Fuzzy subsequence matching for the command palette.
 *
 * Hand-rolled, like everything else here — no dependency, and the scoring
 * rules are the product decision, so they belong in the repo where they can
 * be read and tested rather than inside a package.
 *
 * The score comes from an optimal alignment, not a greedy left-to-right
 * scan: typing `tb` must rank "Trial balance" above "Table of budgets"
 * because `t`+`b` land on two word starts there, and a greedy matcher
 * cannot see the second letter before it commits to the first. The
 * recurrence below is the two-matrix Smith–Waterman variant fzf uses,
 * reduced to two rolling rows (O(query × text) time, O(text) space).
 */

/** A match at the start of a word is worth far more than one mid-word. */
const BONUS_BOUNDARY = 8;
/** …and the very first character even more: prefixes are what people type. */
const BONUS_FIRST = 10;
/** camelCase / PascalCase humps read as word starts too. */
const BONUS_CAMEL = 6;
/** Runs of adjacent characters are the strongest signal of intent. */
const BONUS_CONSECUTIVE = 10;
/** Every matched character is worth something on its own. */
const SCORE_MATCH = 8;
/** Skipping text between matches costs, so tighter matches win. */
const PENALTY_GAP = 3;

/** Longer haystacks are matched, but never preferred at equal quality. */
const MAX_TEXT = 160;

const NEG = -1e9;

function isAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90)
  );
}

/** Positional bonus for matching `text[j]`, given the raw (uncased) text. */
function positionBonus(text: string, j: number): number {
  if (j === 0) return BONUS_FIRST;
  const prev = text.charCodeAt(j - 1);
  const cur = text.charCodeAt(j);
  if (!isAlnum(prev)) return BONUS_BOUNDARY;
  // lower→upper transition: "trialBalance" should treat B as a word start.
  if (prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90) return BONUS_CAMEL;
  return 0;
}

/**
 * Score `text` against `query`, or `null` when `query` is not a subsequence
 * of `text` (case-insensitive). Higher is better; the scale is arbitrary and
 * only comparable between candidates scored against the same query.
 *
 * An empty query scores 0 for everything — callers fall back to their own
 * natural ordering rather than an arbitrary one.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;
  const raw = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const t = raw.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n > m) return null;

  // Cheap reject: bail before allocating when a letter is simply absent.
  for (let i = 0; i < n; i++) if (!t.includes(q[i]!)) return null;

  // `H[j]` — best score for the first `j` characters of the text having
  // consumed `i` query characters. `D[j]` — the same, but only counting
  // alignments where text[j-1] was itself a match (that is what lets the
  // next row know whether it is extending a run).
  let prevH = new Float64Array(m + 1); // i = 0: matching nothing costs nothing
  let prevD = new Float64Array(m + 1).fill(NEG);

  for (let i = 0; i < n; i++) {
    const H = new Float64Array(m + 1).fill(NEG);
    const D = new Float64Array(m + 1).fill(NEG);
    const qc = q[i]!;
    for (let j = i; j < m; j++) {
      let d = NEG;
      if (t[j] === qc && prevH[j]! > NEG / 2) {
        d =
          prevH[j]! +
          SCORE_MATCH +
          positionBonus(raw, j) +
          (prevD[j]! > NEG / 2 ? BONUS_CONSECUTIVE : 0);
      }
      D[j + 1] = d;
      const skip = H[j]! > NEG / 2 ? H[j]! - PENALTY_GAP : NEG;
      H[j + 1] = d > skip ? d : skip;
    }
    prevH = H;
    prevD = D;
  }

  // The answer is the best alignment *ending on a match*, not the value
  // carried to the end of the string. Only the gaps *between* matched
  // characters are a cost: text before the first match and after the last is
  // free. Reading `H[m]` instead would tax every trailing character, which
  // ranks "Reconcile" below "Direct recovery" for `rec` — shorter tail wins
  // over better match, which is precisely backwards.
  let best = NEG;
  for (let j = 1; j <= m; j++) if (prevD[j]! > best) best = prevD[j]!;
  return best > NEG / 2 ? best : null;
}

/**
 * Indices of `text` to highlight for `query`, or `[]` when it does not
 * match. Deliberately a plain greedy pass that prefers word starts: it is
 * only ever used to bold characters, and disagreeing with `fuzzyScore` by a
 * character costs nothing while keeping the DP allocation-free.
 */
export function fuzzyPositions(query: string, text: string): number[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const t = text.toLowerCase();
  const out: number[] = [];
  let from = 0;
  for (const qc of q) {
    // Prefer the next occurrence that starts a word; fall back to the next.
    let chosen = -1;
    for (let j = from; j < t.length; j++) {
      if (t[j] !== qc) continue;
      if (chosen === -1) chosen = j;
      if (positionBonus(text, j) > 0) {
        chosen = j;
        break;
      }
    }
    if (chosen === -1) return [];
    out.push(chosen);
    from = chosen + 1;
  }
  return out;
}

/** `fuzzyPositions` output as alternating plain/matched runs, for rendering. */
export interface HighlightRun {
  text: string;
  hit: boolean;
}

export function highlight(query: string, text: string): HighlightRun[] {
  const hits = new Set(fuzzyPositions(query, text));
  if (hits.size === 0) return [{ text, hit: false }];
  const runs: HighlightRun[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i]!;
    else runs.push({ text: text[i]!, hit });
  }
  return runs;
}
