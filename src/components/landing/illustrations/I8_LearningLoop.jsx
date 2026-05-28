export default function I8_LearningLoop({ className }) {
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
      <g className="text-accent" strokeWidth="1.5">
        <path
          className="stroke-current"
          d="M60 14 a26 26 0 1 1 -18.4 7.6"
        />
        <path
          className="stroke-current"
          d="M41.6 21.6 L36 18 L40 26"
        />
      </g>

      <g className="text-ink-900" strokeWidth="1.2">
        <circle
          className="stroke-current"
          cx="34"
          cy="40"
          r="3"
          fill="currentColor"
        />
        <circle
          className="stroke-current"
          cx="86"
          cy="40"
          r="3"
          fill="currentColor"
        />
      </g>

      <g
        className="text-ink-500"
        fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
        fontSize="9"
        fill="currentColor"
      >
        <text x="6" y="44" textAnchor="start">correct</text>
        <text x="94" y="44" textAnchor="start">learn</text>
      </g>

      <g className="text-accent">
        <circle className="fill-current" cx="60" cy="14" r="3" />
      </g>

      <g className="text-ink-300" strokeWidth="1">
        <line
          className="stroke-current"
          x1="60"
          y1="66"
          x2="60"
          y2="70"
          opacity="0.6"
        />
      </g>
    </svg>
  );
}
