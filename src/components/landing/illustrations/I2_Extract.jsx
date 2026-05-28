export default function I2_Extract({ className }) {
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
      <g
        className="text-ink-900"
        strokeWidth="1.5"
        transform="translate(48 22) rotate(-1.5)"
      >
        <path className="stroke-current" d="M0 0 H92 V154" />
        <path className="stroke-current" d="M0 0 V158" />
        <path
          className="stroke-current"
          d="M0 158 L6 154 L12 158 L18 154 L24 158 L30 154 L36 158 L42 154 L48 158 L54 154 L60 158 L66 154 L72 158 L78 154 L84 158 L92 154 V158"
        />

        <line className="stroke-current" x1="12" y1="18" x2="56" y2="18" opacity="0.45" />
        <line className="stroke-current" x1="12" y1="26" x2="42" y2="26" opacity="0.35" />

        <line className="stroke-current" x1="12" y1="48" x2="68" y2="48" opacity="0.55" />
        <line className="stroke-current" x1="12" y1="60" x2="58" y2="60" opacity="0.45" />
        <line className="stroke-current" x1="12" y1="72" x2="64" y2="72" opacity="0.45" />
        <line className="stroke-current" x1="12" y1="84" x2="50" y2="84" opacity="0.45" />

        <line className="stroke-current" x1="12" y1="108" x2="80" y2="108" opacity="0.7" />

        <line className="stroke-current" x1="12" y1="130" x2="58" y2="130" opacity="0.35" />
      </g>

      <g className="text-ink-300" strokeWidth="1.2">
        <line className="stroke-current" x1="142" y1="48" x2="186" y2="48" />
        <line className="stroke-current" x1="186" y1="48" x2="186" y2="52" />
        <line className="stroke-current" x1="142" y1="48" x2="142" y2="44" />

        <line className="stroke-current" x1="142" y1="108" x2="194" y2="108" />
        <line className="stroke-current" x1="194" y1="108" x2="194" y2="112" />
        <line className="stroke-current" x1="142" y1="108" x2="142" y2="104" />

        <line className="stroke-current" x1="142" y1="156" x2="178" y2="156" />
        <line className="stroke-current" x1="178" y1="156" x2="178" y2="160" />
        <line className="stroke-current" x1="142" y1="156" x2="142" y2="152" />
      </g>

      <g
        className="text-ink-500"
        fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
        fontSize="9"
        fill="currentColor"
      >
        <text x="194" y="51">vendor</text>
        <text x="202" y="111">total</text>
        <text x="186" y="159">vat</text>
      </g>

      <g className="text-accent">
        <circle className="fill-current" cx="190" cy="48" r="2.5" />
        <circle className="fill-current" cx="198" cy="108" r="2.5" />
        <circle className="fill-current" cx="182" cy="156" r="2.5" />
      </g>

      <g className="text-accent" strokeWidth="1.2" transform="translate(94 108)">
        <line className="stroke-current" x1="-8" y1="0" x2="8" y2="0" />
        <line className="stroke-current" x1="0" y1="-8" x2="0" y2="8" />
        <rect
          className="stroke-current"
          x="-5"
          y="-5"
          width="10"
          height="10"
          opacity="0.6"
        />
      </g>
    </svg>
  );
}
