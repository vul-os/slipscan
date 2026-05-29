/**
 * Slack brand icon — the four-coloured "hashtag" mark.
 * Brand colours (official, from Slack brand guidelines):
 *   #E01E5A  — aubergine/red  (bottom-left pill ends + top-right pill ends)
 *   #36C5F0  — blue           (top-left cluster)
 *   #2EB67D  — green          (top-right cluster)
 *   #ECB22E  — yellow         (bottom-right cluster)
 *
 * Coordinates derived from Slack's official SVG logo (256.5 × 256.5 viewBox),
 * scaled uniformly to fit a 24 × 24 viewBox (scale = 24/256.5 ≈ 0.093567).
 *
 * Each of the 8 path elements below is one rounded bar of the hashtag mark.
 */
export default function SlackIcon({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      role="img"
      className={className}
    >
      {/*
        Each <path> below uses an inline transform="scale(s)" applied to
        the original 256.5-space coordinates so the maths stays readable.
        We apply a single group transform for DRY scaling.
      */}
      <g transform={`scale(${(24 / 256.5).toFixed(6)})`}>
        {/* ── RED / AUBERGINE ── */}
        {/* bottom-left pill — vertical arm ending in lower-left */}
        <path
          fill="#E01E5A"
          d="M54,162 C54,176.912 41.912,189 27,189 C12.088,189 0,176.912 0,162
             C0,147.088 12.088,135 27,135 L54,135 Z"
        />
        {/* left vertical bar — red segment (lower half of left column) */}
        <path
          fill="#E01E5A"
          d="M67.5,162 C67.5,147.088 79.588,135 94.5,135 C109.412,135 121.5,147.088 121.5,162
             L121.5,229.5 C121.5,244.412 109.412,256.5 94.5,256.5 C79.588,256.5 67.5,244.412 67.5,229.5 Z"
        />

        {/* ── BLUE ── */}
        {/* top horizontal bar — blue segment (upper half of top row) */}
        <path
          fill="#36C5F0"
          d="M94.5,54 C79.588,54 67.5,41.912 67.5,27 C67.5,12.088 79.588,0 94.5,0
             C109.412,0 121.5,12.088 121.5,27 L121.5,54 Z"
        />
        {/* top horizontal row — left half */}
        <path
          fill="#36C5F0"
          d="M94.5,67.5 C109.412,67.5 121.5,79.588 121.5,94.5 C121.5,109.412 109.412,121.5 94.5,121.5
             L27,121.5 C12.088,121.5 0,109.412 0,94.5 C0,79.588 12.088,67.5 27,67.5 Z"
        />

        {/* ── GREEN ── */}
        {/* right column — green segment (upper half of right column) */}
        <path
          fill="#2EB67D"
          d="M202.5,94.5 C202.5,79.588 214.588,67.5 229.5,67.5 C244.412,67.5 256.5,79.588 256.5,94.5
             C256.5,109.412 244.412,121.5 229.5,121.5 L202.5,121.5 Z"
        />
        {/* right vertical bar — green segment */}
        <path
          fill="#2EB67D"
          d="M189,94.5 C189,109.412 176.912,121.5 162,121.5 C147.088,121.5 135,109.412 135,94.5
             L135,27 C135,12.088 147.088,0 162,0 C176.912,0 189,12.088 189,27 Z"
        />

        {/* ── YELLOW ── */}
        {/* bottom-right pill cap */}
        <path
          fill="#ECB22E"
          d="M162,202.5 C176.912,202.5 189,214.588 189,229.5 C189,244.412 176.912,256.5 162,256.5
             C147.088,256.5 135,244.412 135,229.5 L135,202.5 Z"
        />
        {/* bottom horizontal row — right half */}
        <path
          fill="#ECB22E"
          d="M162,189 C147.088,189 135,176.912 135,162 C135,147.088 147.088,135 162,135
             L229.5,135 C244.412,135 256.5,147.088 256.5,162 C256.5,176.912 244.412,189 229.5,189 Z"
        />
      </g>
    </svg>
  );
}
