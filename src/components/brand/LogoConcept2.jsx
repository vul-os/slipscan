// Concept 2 — Receipt corner.
// A till slip with a folded top-right corner. A single lime scan-line crosses
// the page — the moment of extraction. Geometric, paper-as-mark. The deckled
// bottom is reduced to a single chevron tear so it reads at favicon size.

const ACCENT = "#C8FF00";

function Mark({ size = 32, bg = "dark", className }) {
  const isDark = bg === "dark";
  const ink = isDark ? "#0A0A0A" : "#FFFFFF";
  const paper = isDark ? "#FAFAFA" : "#18181B";
  const fold = isDark ? "#A1A1AA" : "#71717A";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="slip/scan"
    >
      <rect width="32" height="32" rx="7" fill={ink} />
      {/* Receipt body — folded top-right corner + tear at bottom */}
      <path
        d="M9 7 H19.5 L24.5 12 V22 L21 25 L16 22 L11 25 L9 22 Z"
        fill={paper}
      />
      {/* Folded corner — small triangle */}
      <path
        d="M19.5 7 L19.5 12 L24.5 12 Z"
        fill={fold}
        fillOpacity="0.35"
      />
      <path
        d="M19.5 7 L24.5 12"
        stroke={fold}
        strokeOpacity="0.55"
        strokeWidth="1"
        strokeLinecap="round"
      />
      {/* Lime scan line — caught text */}
      <path
        d="M12 15.5 H21.5"
        stroke={ACCENT}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Lockup({ size = 32, bg = "dark", className }) {
  const isDark = bg === "dark";
  const text = isDark ? "#FAFAFA" : "#0A0A0A";

  return (
    <div
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.28 }}
    >
      <Mark size={size} bg={bg} />
      <span
        style={{
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          fontWeight: 500,
          fontSize: size * 0.62,
          letterSpacing: "-0.04em",
          color: text,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "baseline",
        }}
      >
        <span>slip</span>
        <span style={{ color: ACCENT, padding: "0 0.04em" }}>/</span>
        <span>scan</span>
      </span>
    </div>
  );
}

export default { Mark, Lockup };
