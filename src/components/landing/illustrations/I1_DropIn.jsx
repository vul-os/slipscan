export default function I1_DropIn({ className }) {
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
        <rect
          className="stroke-current"
          x="34"
          y="36"
          width="86"
          height="142"
          rx="11"
          transform="rotate(-2 77 107)"
        />
        <rect
          className="stroke-current"
          x="44"
          y="50"
          width="66"
          height="106"
          rx="3"
          transform="rotate(-2 77 103)"
          opacity="0.55"
        />
        <line
          className="stroke-current"
          x1="66"
          y1="170"
          x2="90"
          y2="170"
          opacity="0.7"
          transform="rotate(-2 77 170)"
        />
      </g>

      <g
        className="text-ink-900"
        strokeWidth="1.2"
        transform="translate(77 100) rotate(-2)"
      >
        <circle className="stroke-current" cx="0" cy="0" r="14" opacity="0.55" />
        <line className="stroke-current" x1="-19" y1="0" x2="-10" y2="0" />
        <line className="stroke-current" x1="10" y1="0" x2="19" y2="0" />
        <line className="stroke-current" x1="0" y1="-19" x2="0" y2="-10" />
        <line className="stroke-current" x1="0" y1="10" x2="0" y2="19" />
      </g>

      <g
        className="text-ink-900"
        strokeWidth="1.5"
        transform="translate(196 56) rotate(8)"
      >
        <path
          className="stroke-current"
          d="M0 0 H60 V92"
        />
        <path
          className="stroke-current"
          d="M0 0 V96"
        />
        <path
          className="stroke-current"
          d="M0 96 L6 92 L12 96 L18 92 L24 96 L30 92 L36 96 L42 92 L48 96 L54 92 L60 96 V92"
        />
        <line className="stroke-current" x1="8" y1="18" x2="48" y2="18" opacity="0.55" />
        <line className="stroke-current" x1="8" y1="30" x2="44" y2="30" opacity="0.55" />
        <line className="stroke-current" x1="8" y1="42" x2="50" y2="42" opacity="0.55" />
        <line className="stroke-current" x1="8" y1="54" x2="38" y2="54" opacity="0.55" />
        <line className="stroke-current" x1="8" y1="66" x2="46" y2="66" opacity="0.55" />
        <line className="stroke-current" x1="8" y1="78" x2="40" y2="78" opacity="0.55" />
      </g>

      <g className="text-accent" strokeWidth="1.5">
        <path
          className="stroke-current"
          d="M86 70 Q150 6 208 64"
          strokeDasharray="2 4"
        />
        <circle className="fill-current" cx="150" cy="24" r="3" stroke="none" />
      </g>

      <g className="text-accent" strokeWidth="1.2">
        <path
          className="stroke-current"
          d="M203 60 l5 5 M213 65 l-5 0 M208 60 l0 5"
          opacity="0.7"
        />
      </g>
    </svg>
  );
}
