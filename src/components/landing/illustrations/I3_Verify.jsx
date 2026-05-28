export default function I3_Verify({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 280 200"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className="text-ink-900" strokeWidth="1.5">
        <rect className="stroke-current" x="32" y="46" width="158" height="28" rx="4" transform="rotate(-1 111 60)" />
        <rect className="stroke-current" x="32" y="86" width="158" height="28" rx="4" />
        <rect className="stroke-current" x="32" y="126" width="158" height="28" rx="4" transform="rotate(1 111 140)" />
      </g>

      <g className="text-ink-300" strokeWidth="1.2">
        <line className="stroke-current" x1="62" y1="60" x2="152" y2="60" />
        <line className="stroke-current" x1="62" y1="100" x2="138" y2="100" />
        <line className="stroke-current" x1="62" y1="140" x2="148" y2="140" />
      </g>

      <g className="text-accent" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path className="stroke-current" d="M44 60 l4 4 l8 -8" />
        <path className="stroke-current" d="M44 100 l4 4 l8 -8" />
        <path className="stroke-current" d="M44 140 l4 4 l8 -8" />
      </g>

      <g className="text-accent" strokeWidth="2">
        <line className="stroke-current" x1="62" y1="148" x2="170" y2="148" />
      </g>

      <g
        className="text-ink-900"
        transform="translate(206 128)"
        strokeWidth="1.2"
      >
        <rect
          className="stroke-current"
          x="0"
          y="0"
          width="58"
          height="22"
          rx="6"
        />
        <text
          x="8"
          y="15"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="9"
          fill="currentColor"
        >
          Posted
        </text>
        <path
          className="stroke-accent"
          d="M42 11 l3 3 l6 -6"
          strokeWidth="1.6"
        />
      </g>

      <g className="text-ink-300" strokeWidth="1.2">
        <line className="stroke-current" x1="194" y1="139" x2="206" y2="139" strokeDasharray="2 3" />
      </g>
    </svg>
  );
}
