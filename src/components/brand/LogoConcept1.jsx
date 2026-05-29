// Concept 1 — Slash refined.
// A scan-window square frames a single confident slash. The slash crosses the
// frame's bottom-left and top-right corners, reading as both "/" (the product
// name's pivot) and a scan reticle. One lime stroke, restrained.

const ACCENT = "#C8FF00";

function Mark({ size = 32, bg = "dark", className }) {
  const isDark = bg === "dark";
  const frame = isDark ? "#FFFFFF" : "#0A0A0A";
  const ink = isDark ? "#0A0A0A" : "#FFFFFF";

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
      {/* Scan window — a soft inset frame */}
      <rect
        x="6.5"
        y="6.5"
        width="19"
        height="19"
        rx="2.5"
        stroke={frame}
        strokeOpacity="0.22"
        strokeWidth="1"
      />
      {/* The slash — corner-to-corner inside the frame */}
      <path
        d="M22 9 L10 23"
        stroke={ACCENT}
        strokeWidth="2.5"
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
