<script lang="ts">
  /**
   * Net worth over time — a single-series step-free line/area chart, drawn
   * as inline SVG (no charting dependency; the repo ships no CDN and no
   * remote assets, see ARCHITECTURE.md).
   *
   * One series, so no legend — the card title already names it (dataviz
   * convention: a legend earns its place at two series, not one). The line
   * is thin (2px), the fill is a soft gradient down to the chart's own
   * baseline; direct labels are the requested date range, the zero
   * baseline, the series max and the current total at the end-cap —
   * everything else lives in the hover tooltip so the chart itself stays
   * quiet.
   *
   * The x-axis spans `rangeFrom`..`rangeTo` — the window the caller actually
   * asked the backend for — rather than merely the extent of the points that
   * came back. A book with three months of history inside a twelve-month
   * request must draw as three months of line sitting in a twelve-month
   * axis, not as a rescaled line that quietly claims the whole window: the
   * caller's period label (e.g. "last 12 months") is only honest if the
   * axis underneath actually shows that period. See Dashboard.svelte, the
   * "Net worth" card header.
   *
   * `unconvertedNotice` — when a point excluded a currency for lack of a
   * cached exchange rate, that is stated in the caption under the chart,
   * never silently folded into the line.
   */
  import type { NetWorthPoint } from "../api/types";
  import { fmtDate, fmtMoney } from "../format";

  let {
    points,
    currency,
    rangeFrom,
    rangeTo,
  }: {
    points: NetWorthPoint[];
    currency: string;
    /** The `from`/`to` actually requested (`YYYY-MM-DD`), which is what the
     * axis is drawn to span — see the module doc above. */
    rangeFrom: string;
    rangeTo: string;
  } = $props();

  const width = 640;
  // Short (not the ~500px-tall near-straight-line this used to render): a
  // net-worth trend needs to be legible as a shape, not a hero visual.
  const height = 140;
  const padTop = 20;
  const padBottom = 24;
  const padLeft = 8;
  const padRight = 8;

  const parsed = $derived(
    points.map((p) => ({ ...p, t: Date.parse(`${p.as_of_date}T00:00:00Z`) })),
  );

  const domain = $derived.by(() => {
    if (parsed.length === 0) return { tMin: 0, tMax: 1, vMin: 0, vMax: 1 };
    const values = parsed.map((p) => p.total_minor);
    // The requested window, not the data's own extent — widened (never
    // narrowed) to the data in the edge case where a point falls outside it,
    // so a real snapshot is never clipped off the chart.
    const requestedMin = Date.parse(`${rangeFrom}T00:00:00Z`);
    const requestedMax = Date.parse(`${rangeTo}T00:00:00Z`);
    const tMin = Math.min(requestedMin, parsed[0].t);
    const tMax = Math.max(requestedMax, parsed[parsed.length - 1].t);
    // The baseline always includes zero, so a net-worth line that dips
    // negative is visibly below it rather than silently rescaled to look
    // like the bottom of the chart.
    let vMin = Math.min(0, ...values);
    let vMax = Math.max(0, ...values);
    if (vMin === vMax) {
      // A flat (or single-point) series still needs vertical room to draw.
      const pad = Math.max(1, Math.abs(vMin) * 0.1);
      vMin -= pad;
      vMax += pad;
    } else {
      const pad = (vMax - vMin) * 0.08;
      vMin -= pad;
      vMax += pad;
    }
    return { tMin, tMax, vMin, vMax };
  });

  function x(t: number): number {
    const { tMin, tMax } = domain;
    if (tMax === tMin) return width / 2;
    return padLeft + ((t - tMin) / (tMax - tMin)) * (width - padLeft - padRight);
  }

  function y(v: number): number {
    const { vMin, vMax } = domain;
    const usable = height - padTop - padBottom;
    if (vMax === vMin) return padTop + usable / 2;
    return padTop + usable - ((v - vMin) / (vMax - vMin)) * usable;
  }

  const coords = $derived(parsed.map((p) => ({ ...p, cx: x(p.t), cy: y(p.total_minor) })));

  const linePath = $derived(
    coords.length === 0
      ? ""
      : coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.cx},${c.cy}`).join(" "),
  );

  const areaPath = $derived(
    coords.length === 0
      ? ""
      : `${linePath} L${coords[coords.length - 1].cx},${y(domain.vMin)} ` +
        `L${coords[0].cx},${y(domain.vMin)} Z`,
  );

  const zeroY = $derived(y(0));
  const zeroVisible = $derived(domain.vMin < 0 && domain.vMax > 0);

  const last = $derived(coords.length > 0 ? coords[coords.length - 1] : null);

  // -- y-axis reference ----------------------------------------------------
  //
  // A shape with no value anywhere near it can only be read as "up" or
  // "down", never "worth about how much" — this is the minimal reference the
  // dataviz guide calls for (min/max labels, or a gridline) on an otherwise
  // deliberately quiet chart: the actual series peak (not the padded domain
  // ceiling) at the top, and the zero baseline already drawn above.
  const seriesMax = $derived(
    parsed.length > 0 ? Math.max(...parsed.map((p) => p.total_minor)) : 0,
  );
  const seriesMaxY = $derived(y(seriesMax));

  // -- hover / crosshair --------------------------------------------------

  let hoverIndex = $state<number | null>(null);
  const hovered = $derived(hoverIndex === null ? null : coords[hoverIndex]);

  function nearestIndex(clientX: number, svg: SVGSVGElement): number {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestDist = Infinity;
    coords.forEach((c, i) => {
      const d = Math.abs(c.cx - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function onMove(e: PointerEvent) {
    if (coords.length === 0) return;
    hoverIndex = nearestIndex(e.clientX, e.currentTarget as SVGSVGElement);
  }

  function onLeave() {
    hoverIndex = null;
  }

  const unconvertedCurrencies = $derived(
    Array.from(new Set(points.flatMap((p) => p.unconverted))).sort(),
  );

  // States the axis range actually drawn (rangeFrom..rangeTo), and — only
  // when it differs — the shorter span the data on record actually covers.
  // Keeping both true is the point of this component: a short book must
  // never read, to a screen reader either, as if it had the full window.
  const chartLabel = $derived.by(() => {
    if (points.length === 0) return "";
    const first = points[0]!.as_of_date;
    const latestPoint = points[points.length - 1]!;
    const coverage =
      first === rangeFrom ? "" : ` — on record from ${fmtDate(first)}`;
    return (
      `Net worth, ${fmtDate(rangeFrom)} to ${fmtDate(rangeTo)}${coverage}; ` +
      `latest ${fmtMoney(latestPoint.total_minor, currency)}`
    );
  });
</script>

{#if coords.length > 0}
  <div class="relative">
    <svg
      viewBox="0 0 {width} {height}"
      class="block w-full touch-none"
      role="img"
      aria-label={chartLabel}
      onpointermove={onMove}
      onpointerleave={onLeave}
    >
      <defs>
        <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- Minimal y-axis reference: the zero baseline and the series peak,
           each a hairline gridline drawn *behind* the fill (so it only shows
           through where the shape doesn't cover it, never cutting across the
           line), with its value right-aligned at the same edge below. -->
      {#if zeroVisible}
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--ss-line)"
          stroke-width="1"
        />
      {/if}
      {#if last && seriesMax !== 0}
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={seriesMaxY}
          y2={seriesMaxY}
          stroke="var(--ss-line)"
          stroke-width="1"
          opacity="0.6"
        />
      {/if}

      <path d={areaPath} fill="url(#nw-fill)" />
      <path
        d={linePath}
        fill="none"
        stroke="var(--chart-1)"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      {#if last}
        <circle cx={last.cx} cy={last.cy} r="3.5" fill="var(--chart-1)" />
      {/if}

      {#if hovered}
        <line
          x1={hovered.cx}
          x2={hovered.cx}
          y1={padTop}
          y2={height - padBottom}
          stroke="var(--ss-line-2)"
          stroke-width="1"
          stroke-dasharray="2 2"
        />
        <circle
          cx={hovered.cx}
          cy={hovered.cy}
          r="4"
          fill="var(--ss-panel)"
          stroke="var(--chart-1)"
          stroke-width="2"
        />
      {/if}

      <!-- Axis start/end are the requested window, not merely the data's own
           extent — so a book with three months of history inside a
           twelve-month request draws as three months of line sitting in a
           twelve-month axis, matching whatever period the caller claims
           above the chart. -->
      <text
        x={padLeft}
        y={height - 8}
        fill="var(--ss-t3)"
        font-size="10.5"
        text-anchor="start">{fmtDate(rangeFrom)}</text
      >
      <text
        x={width - padRight}
        y={height - 8}
        fill="var(--ss-t3)"
        font-size="10.5"
        text-anchor="end">{fmtDate(rangeTo)}</text
      >

      <!-- The reference values themselves, right-aligned at the same edge
           as their gridline above, so the two read as one small y-axis
           rather than two disconnected captions. -->
      {#if zeroVisible}
        <text
          x={width - padRight}
          y={zeroY - 5}
          fill="var(--ss-t3)"
          font-size="10.5"
          text-anchor="end">0</text
        >
      {/if}
      {#if last && seriesMax !== 0}
        <text
          x={width - padRight}
          y={Math.max(11, seriesMaxY - 5)}
          fill="var(--ss-t3)"
          font-size="10.5"
          text-anchor="end">{fmtMoney(seriesMax, currency)}</text
        >
      {/if}
    </svg>

    {#if hovered}
      <div
        class="elev-overlay pointer-events-none absolute top-1 max-w-[13rem] -translate-x-1/2 px-2.5 py-1.5 text-[11.5px]"
        style="left: {(hovered.cx / width) * 100}%"
      >
        <p class="font-medium text-t1">{fmtMoney(hovered.total_minor, currency)}</p>
        <p class="text-t3">{fmtDate(hovered.as_of_date)}</p>
        {#if hovered.unconverted.length > 0}
          <p class="mt-0.5 text-warning">excludes {hovered.unconverted.join(", ")}</p>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Screen-reader / no-JS-hover table view of the same series. -->
  <table class="sr-only">
    <caption>Net worth by date, in {currency}</caption>
    <thead>
      <tr><th scope="col">Date</th><th scope="col">Total</th></tr>
    </thead>
    <tbody>
      {#each points as p (p.as_of_date)}
        <tr>
          <td>{p.as_of_date}</td>
          <td>{fmtMoney(p.total_minor, currency)}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if unconvertedCurrencies.length > 0}
    <p class="mt-2 text-[11px] text-t3">
      Excludes {unconvertedCurrencies.join(", ")} — no cached exchange rate to {currency}.
    </p>
  {/if}
{/if}
