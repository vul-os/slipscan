// Concept 3 — S monogram.
// A geometric S built from a single continuous polyline — top bar, diagonal
// down-left, middle bar, diagonal down-right, bottom bar — like a chunky 7-seg
// digit. The middle bar is lime. Doubles as both S's in slip/scan and reads
// as a confident, original brand mark (not a typeface S).

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
      {/* Top arm: horizontal bar then diagonal down-left */}
      <path
        d="M23 9 H13 L10.5 15.5"
        stroke={fg}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Middle connector — the lime accent */}
      <path
        d="M10.5 15.5 H21.5"
        stroke={ACCENT}
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* Bottom arm: diagonal down-right then horizontal bar */}
      <path
        d="M21.5 15.5 L19 22 H9"
        stroke={fg}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
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
            "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontWeight: 500,
          fontSize: size * 0.56,
          letterSpacing: "-0.025em",
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
