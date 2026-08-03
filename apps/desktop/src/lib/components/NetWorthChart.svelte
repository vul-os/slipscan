<script lang="ts">
  /**
   * Net worth over time — a single-series step-free line/area chart, drawn
   * as inline SVG (no charting dependency; the repo ships no CDN and no
   * remote assets, see ARCHITECTURE.md).
   *
   * One series, so no legend — the card title already names it (dataviz
   * convention: a legend earns its place at two series, not one). The line
   * is thin (2px), the fill is a soft gradient down to the chart's own
   * baseline, and the only labels drawn directly on the chart are the first
   * and last dates plus the current total at the end-cap — everything else
   * lives in the hover tooltip so the chart itself stays quiet.
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
  }: {
    points: NetWorthPoint[];
    currency: string;
  } = $props();

  const width = 640;
  const height = 220;
  const padTop = 16;
  const padBottom = 28;
  const padLeft = 8;
  const padRight = 8;

  const parsed = $derived(
    points.map((p) => ({ ...p, t: Date.parse(`${p.as_of_date}T00:00:00Z`) })),
  );

  const domain = $derived.by(() => {
    if (parsed.length === 0) return { tMin: 0, tMax: 1, vMin: 0, vMax: 1 };
    const values = parsed.map((p) => p.total_minor);
    const tMin = parsed[0].t;
    const tMax = parsed[parsed.length - 1].t;
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
</script>

{#if coords.length > 0}
  <div class="relative">
    <svg
      viewBox="0 0 {width} {height}"
      class="block w-full touch-none"
      role="img"
      aria-label="Net worth from {fmtDate(points[0].as_of_date)} to {fmtDate(
        points[points.length - 1].as_of_date,
      )}, ending at {fmtMoney(points[points.length - 1].total_minor, currency)}"
      onpointermove={onMove}
      onpointerleave={onLeave}
    >
      <defs>
        <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0" />
        </linearGradient>
      </defs>

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

      <!-- First/last date only — selective direct labels, not one per point. -->
      <text
        x={padLeft}
        y={height - 8}
        fill="var(--ss-t3)"
        font-size="10.5"
        text-anchor="start">{fmtDate(points[0].as_of_date)}</text
      >
      <text
        x={width - padRight}
        y={height - 8}
        fill="var(--ss-t3)"
        font-size="10.5"
        text-anchor="end">{fmtDate(points[points.length - 1].as_of_date)}</text
      >
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
