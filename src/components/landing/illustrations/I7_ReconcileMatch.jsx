export default function I7_ReconcileMatch({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 80"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className="text-ink-900" strokeWidth="1.5">
        <rect
          className="stroke-current"
          x="6"
          y="22"
          width="44"
          height="36"
          rx="5"
          transform="rotate(-2 28 40)"
        />
        <rect
          className="stroke-current"
          x="70"
          y="22"
          width="44"
          height="36"
          rx="5"
          transform="rotate(2 92 40)"
        />
      </g>

      <g
        className="text-ink-500"
        fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
        fontSize="9"
        fill="currentColor"
      >
        <text x="16" y="44" transform="rotate(-2 28 40)">slip</text>
        <text x="80" y="44" transform="rotate(2 92 40)">feed</text>
      </g>

      <g className="text-ink-300" strokeWidth="1">
        <line
          className="stroke-current"
          x1="14"
          y1="50"
          x2="42"
          y2="50"
          transform="rotate(-2 28 40)"
          opacity="0.7"
        />
        <line
          className="stroke-current"
          x1="78"
          y1="50"
          x2="106"
          y2="50"
          transform="rotate(2 92 40)"
          opacity="0.7"
        />
      </g>

      <g className="text-accent" strokeWidth="1.4">
        <line
          className="stroke-current"
          x1="50"
          y1="40"
          x2="70"
          y2="40"
          strokeDasharray="2 3"
        />
      </g>

      <g className="text-accent" strokeWidth="1.6">
        <circle
          className="stroke-current"
          cx="60"
          cy="40"
          r="6"
          fill="currentColor"
          fillOpacity="0.15"
        />
        <path
          className="stroke-current"
          d="M56.5 40 l2.5 2.5 l4.5 -5"
        />
      </g>
    </svg>
  );
}
