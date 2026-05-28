export default function I4_PaperToTable({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 480 320"
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
        transform="translate(38 38) rotate(-3)"
      >
        <path
          className="stroke-current"
          d="M0 6 Q4 0 12 2 L96 0 Q108 -1 112 6 L116 38 Q122 42 118 50 L120 86 Q116 96 122 104 L116 138 Q120 150 114 158 L118 196 Q116 210 110 214"
        />
        <path
          className="stroke-current"
          d="M0 6 L-2 42 Q2 50 -4 58 L-2 92 Q4 102 -2 110 L0 146 Q-4 158 2 168 L-2 204 Q0 216 6 218"
        />
        <path
          className="stroke-current"
          d="M6 218 L18 214 L26 220 L36 215 L46 221 L58 214 L68 220 L80 215 L92 220 L102 214 L110 220 Q116 218 110 214"
        />

        <line className="stroke-current" x1="14" y1="28" x2="86" y2="26" opacity="0.55" />
        <line className="stroke-current" x1="14" y1="38" x2="64" y2="36" opacity="0.4" />

        <line className="stroke-current" x1="14" y1="64" x2="92" y2="64" opacity="0.6" />
        <line className="stroke-current" x1="14" y1="76" x2="78" y2="76" opacity="0.45" />
        <line className="stroke-current" x1="14" y1="88" x2="86" y2="88" opacity="0.45" />
        <line className="stroke-current" x1="14" y1="100" x2="70" y2="100" opacity="0.45" />
        <line className="stroke-current" x1="14" y1="112" x2="82" y2="112" opacity="0.45" />

        <line className="stroke-current" x1="14" y1="138" x2="98" y2="138" opacity="0.7" />

        <line className="stroke-current" x1="14" y1="166" x2="64" y2="166" opacity="0.4" />
        <line className="stroke-current" x1="14" y1="178" x2="58" y2="178" opacity="0.35" />

        <g opacity="0.35">
          <line className="stroke-current" x1="88" y1="48" x2="94" y2="42" strokeWidth="1" />
          <line className="stroke-current" x1="86" y1="58" x2="92" y2="52" strokeWidth="1" />
          <line className="stroke-current" x1="92" y1="120" x2="98" y2="114" strokeWidth="1" />
          <line className="stroke-current" x1="90" y1="130" x2="96" y2="124" strokeWidth="1" />
          <line className="stroke-current" x1="-2" y1="156" x2="4" y2="150" strokeWidth="1" />
          <line className="stroke-current" x1="-4" y1="166" x2="2" y2="160" strokeWidth="1" />
        </g>

        <path
          className="stroke-current"
          d="M20 196 Q28 188 38 194 Q48 200 58 192"
          opacity="0.3"
        />
        <path
          className="stroke-current"
          d="M28 8 Q40 14 56 8 Q72 4 88 10"
          opacity="0.3"
        />
      </g>

      <g
        className="text-ink-900"
        strokeWidth="1.5"
        transform="translate(266 56) rotate(1)"
      >
        <rect className="stroke-current" x="0" y="0" width="180" height="208" rx="6" />

        <line className="stroke-current" x1="0" y1="28" x2="180" y2="28" />
        <line className="stroke-current" x1="60" y1="0" x2="60" y2="208" opacity="0.55" />
        <line className="stroke-current" x1="108" y1="0" x2="108" y2="208" opacity="0.55" />

        <line className="stroke-current" x1="0" y1="64" x2="180" y2="64" opacity="0.35" />
        <line className="stroke-current" x1="0" y1="100" x2="180" y2="100" opacity="0.35" />
        <line className="stroke-current" x1="0" y1="136" x2="180" y2="136" opacity="0.35" />
        <line className="stroke-current" x1="0" y1="172" x2="180" y2="172" opacity="0.35" />

        <g
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="9"
          fill="currentColor"
        >
          <text x="8" y="19">Item</text>
          <text x="68" y="19">Qty</text>
          <text x="116" y="19">Total</text>
        </g>

        <g
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="10"
          fill="currentColor"
          opacity="0.5"
        >
          <text x="8" y="50">——</text>
          <text x="68" y="50">—</text>
          <text x="116" y="50">———</text>

          <text x="8" y="86">——</text>
          <text x="68" y="86">—</text>
          <text x="116" y="86">———</text>

          <text x="8" y="122">——</text>
          <text x="68" y="122">—</text>
          <text x="116" y="122">———</text>

          <text x="8" y="158">——</text>
          <text x="68" y="158">—</text>
          <text x="116" y="158">———</text>

          <text x="8" y="194">——</text>
          <text x="68" y="194">—</text>
          <text x="116" y="194">———</text>
        </g>
      </g>

      <g className="text-accent" strokeWidth="1.5">
        <path
          className="stroke-current"
          d="M150 80 C 200 60 240 70 280 92"
          strokeDasharray="2 4"
        />
        <path
          className="stroke-current"
          d="M156 156 C 210 148 246 152 280 164"
          strokeDasharray="2 4"
        />
        <path
          className="stroke-current"
          d="M150 220 C 200 230 244 222 280 220"
          strokeDasharray="2 4"
        />
      </g>

      <g className="text-accent">
        <circle className="fill-current" cx="148" cy="80" r="3.5" />
        <circle className="fill-current" cx="282" cy="92" r="3.5" />

        <circle className="fill-current" cx="154" cy="156" r="3.5" />
        <circle className="fill-current" cx="282" cy="164" r="3.5" />

        <circle className="fill-current" cx="148" cy="220" r="3.5" />
        <circle className="fill-current" cx="282" cy="220" r="3.5" />
      </g>

      <g
        className="text-ink-500"
        fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
        fontSize="9"
        fill="currentColor"
        opacity="0.65"
      >
        <text x="196" y="58">vendor</text>
        <text x="206" y="142">total</text>
        <text x="210" y="244">vat</text>
      </g>
    </svg>
  );
}
