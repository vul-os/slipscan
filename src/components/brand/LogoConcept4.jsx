// Concept 4 — Scan reticle.
// Four corner brackets framing a single lime focal dot. Reads as a viewfinder
// / OCR target. Technical, restrained, communicates "capture" without any
// camera or magnifying glass cliché. Reads cleanly at 16x16.

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
      {/* Top-left bracket */}
      <path
        d="M7 11 V8 H10"
        stroke={fg}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Top-right bracket */}
      <path
        d="M22 8 H25 V11"
        stroke={fg}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Bottom-right bracket */}
      <path
        d="M25 21 V24 H22"
        stroke={fg}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Bottom-left bracket */}
      <path
        d="M10 24 H7 V21"
        stroke={fg}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Lime focal — a centred bar, not a dot, to echo the slash */}
      <path
        d="M19 13 L13 19"
        stroke={ACCENT}
        strokeWidth="2.25"
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
