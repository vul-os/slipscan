// Concept 5 — Stacked slashes ("//").
// Two parallel slashes — the longer one is the brand slash, the shorter lime
// one is its shadow / capture-trail. Reads as "//" (the developer-grade comment
// glyph), as motion, and as the moment of capture (the lime is the scan that
// just happened). Editorial, confident, monogrammable.

const ACCENT = "#C8FF00";

function Mark({ size = 32, bg = "dark", className }) {
  const isDark = bg === "dark";
  const ink = isDark ? "#0A0A0A" : "#FFFFFF";
  const fg = isDark ? "#FAFAFA" : "#0A0A0A";

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
      {/* Leading slash — white/ink, slightly shorter */}
      <path
        d="M16 8 L9.5 22"
        stroke={fg}
        strokeWidth="2.75"
        strokeLinecap="round"
      />
      {/* Trailing slash — lime, parallel, offset right */}
      <path
        d="M22.5 10 L17 24"
        stroke={ACCENT}
        strokeWidth="2.75"
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
