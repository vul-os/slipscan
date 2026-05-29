export default function HeroIllustration({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 600 600"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* ----- Faint structural backdrop: corner reticle marks framing the receipt ----- */}
      <g
        className="text-ink-0"
        strokeWidth="1.2"
        opacity="0.18"
        vectorEffect="non-scaling-stroke"
      >
        {/* top-left */}
        <path className="stroke-current" d="M150 132 L150 116 L166 116" />
        {/* top-right */}
        <path className="stroke-current" d="M450 132 L450 116 L434 116" />
        {/* bottom-left */}
        <path className="stroke-current" d="M150 468 L150 484 L166 484" />
        {/* bottom-right */}
        <path className="stroke-current" d="M450 468 L450 484 L434 484" />
      </g>

      {/* ----- Central receipt, tall, slightly rotated, with deckled bottom ----- */}
      <g
        className="text-ink-0"
        strokeWidth="1.5"
        transform="translate(244 116) rotate(-2.4 56 200)"
        vectorEffect="non-scaling-stroke"
      >
        {/* right edge */}
        <path
          className="stroke-current"
          d="M112 4 Q116 0 112 -2 L8 0 Q0 2 2 10 L0 48 Q4 56 0 64 L2 102 Q-2 112 2 120 L-2 162 Q2 172 -2 180 L0 222 Q-4 232 2 240 L0 282 Q4 292 -2 300 L0 342 Q-2 350 4 354"
          opacity="0.92"
        />
        {/* left edge */}
        <path
          className="stroke-current"
          d="M112 4 L114 46 Q110 54 114 62 L116 104 Q112 114 116 122 L114 164 Q118 174 114 182 L116 224 Q112 234 116 242 L114 284 Q118 294 114 302 L116 344 Q112 352 116 356"
          opacity="0.92"
        />
        {/* deckled bottom — the brand's signature jagged tear */}
        <path
          className="stroke-current"
          d="M4 354 L14 350 L24 357 L34 351 L44 358 L54 351 L64 358 L74 351 L84 358 L94 351 L104 358 L116 356"
        />
        {/* deckled top — soft uneven edge */}
        <path
          className="stroke-current"
          d="M2 4 L14 -1 L26 3 L38 -1 L52 2 L66 -1 L80 2 L94 -1 L108 2 L112 4"
          opacity="0.7"
        />

        {/* Vendor block (top) */}
        <line className="stroke-current" x1="14" y1="34" x2="84" y2="34" opacity="0.85" />
        <line className="stroke-current" x1="14" y1="46" x2="62" y2="46" opacity="0.55" />

        {/* Address / meta */}
        <line className="stroke-current" x1="14" y1="68" x2="50" y2="68" opacity="0.35" />
        <line className="stroke-current" x1="14" y1="78" x2="42" y2="78" opacity="0.35" />

        {/* Divider */}
        <line className="stroke-current" x1="14" y1="98" x2="102" y2="98" opacity="0.45" strokeDasharray="2 3" />

        {/* Line items */}
        <line className="stroke-current" x1="14" y1="118" x2="72" y2="118" opacity="0.55" />
        <line className="stroke-current" x1="84" y1="118" x2="102" y2="118" opacity="0.55" />

        <line className="stroke-current" x1="14" y1="134" x2="68" y2="134" opacity="0.55" />
        <line className="stroke-current" x1="84" y1="134" x2="102" y2="134" opacity="0.55" />

        <line className="stroke-current" x1="14" y1="150" x2="76" y2="150" opacity="0.55" />
        <line className="stroke-current" x1="84" y1="150" x2="102" y2="150" opacity="0.55" />

        <line className="stroke-current" x1="14" y1="166" x2="64" y2="166" opacity="0.55" />
        <line className="stroke-current" x1="84" y1="166" x2="102" y2="166" opacity="0.55" />

        <line className="stroke-current" x1="14" y1="182" x2="70" y2="182" opacity="0.55" />
        <line className="stroke-current" x1="84" y1="182" x2="102" y2="182" opacity="0.55" />

        {/* Subtotal divider */}
        <line className="stroke-current" x1="14" y1="206" x2="102" y2="206" opacity="0.45" strokeDasharray="2 3" />

        {/* Subtotal / VAT rows */}
        <line className="stroke-current" x1="14" y1="222" x2="50" y2="222" opacity="0.5" />
        <line className="stroke-current" x1="80" y1="222" x2="102" y2="222" opacity="0.5" />

        <line className="stroke-current" x1="14" y1="238" x2="44" y2="238" opacity="0.5" />
        <line className="stroke-current" x1="80" y1="238" x2="102" y2="238" opacity="0.5" />

        {/* TOTAL — the bold, emphasized line (this is what the lime callout will point at) */}
        <line className="stroke-current" x1="14" y1="266" x2="56" y2="266" strokeWidth="2.2" />
        <line className="stroke-current" x1="72" y1="266" x2="102" y2="266" strokeWidth="2.2" />

        {/* Date / footer */}
        <line className="stroke-current" x1="14" y1="294" x2="60" y2="294" opacity="0.35" />
        <line className="stroke-current" x1="14" y1="306" x2="46" y2="306" opacity="0.35" />

        {/* Barcode-ish marks near the bottom */}
        <g opacity="0.55">
          <line className="stroke-current" x1="22" y1="328" x2="22" y2="340" strokeWidth="1" />
          <line className="stroke-current" x1="28" y1="328" x2="28" y2="340" strokeWidth="2" />
          <line className="stroke-current" x1="34" y1="328" x2="34" y2="340" strokeWidth="1" />
          <line className="stroke-current" x1="40" y1="328" x2="40" y2="340" strokeWidth="1.5" />
          <line className="stroke-current" x1="46" y1="328" x2="46" y2="340" strokeWidth="1" />
          <line className="stroke-current" x1="52" y1="328" x2="52" y2="340" strokeWidth="2.2" />
          <line className="stroke-current" x1="58" y1="328" x2="58" y2="340" strokeWidth="1" />
          <line className="stroke-current" x1="64" y1="328" x2="64" y2="340" strokeWidth="1.5" />
          <line className="stroke-current" x1="70" y1="328" x2="70" y2="340" strokeWidth="1" />
          <line className="stroke-current" x1="76" y1="328" x2="76" y2="340" strokeWidth="2" />
          <line className="stroke-current" x1="82" y1="328" x2="82" y2="340" strokeWidth="1" />
          <line className="stroke-current" x1="88" y1="328" x2="88" y2="340" strokeWidth="1.2" />
          <line className="stroke-current" x1="94" y1="328" x2="94" y2="340" strokeWidth="1.8" />
        </g>
      </g>

      {/* ----- LEFT side callouts: vendor + date ----- */}

      {/* Bracket pointing AT the vendor block */}
      <g
        className="text-ink-300"
        strokeWidth="1.2"
        opacity="0.7"
        vectorEffect="non-scaling-stroke"
      >
        <path
          className="stroke-current"
          d="M244 152 L228 152 L228 132 L168 132"
        />
      </g>
      {/* Vendor chip */}
      <g
        className="text-ink-0"
        strokeWidth="1.2"
        opacity="0.85"
        vectorEffect="non-scaling-stroke"
      >
        <rect
          className="stroke-current"
          x="60"
          y="118"
          width="108"
          height="28"
          rx="4"
          opacity="0.55"
        />
        <text
          x="72"
          y="130"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="9"
          fill="currentColor"
          opacity="0.55"
        >
          vendor
        </text>
        <text
          x="72"
          y="142"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="10"
          fill="currentColor"
        >
          ACME · CO
        </text>
      </g>

      {/* Bracket pointing AT the date block */}
      <g
        className="text-ink-300"
        strokeWidth="1.2"
        opacity="0.7"
        vectorEffect="non-scaling-stroke"
      >
        <path
          className="stroke-current"
          d="M242 414 L222 414 L222 444 L180 444"
        />
      </g>
      {/* Date chip */}
      <g
        className="text-ink-0"
        strokeWidth="1.2"
        opacity="0.85"
        vectorEffect="non-scaling-stroke"
      >
        <rect
          className="stroke-current"
          x="72"
          y="430"
          width="108"
          height="28"
          rx="4"
          opacity="0.55"
        />
        <text
          x="84"
          y="442"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="9"
          fill="currentColor"
          opacity="0.55"
        >
          date
        </text>
        <text
          x="84"
          y="454"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="10"
          fill="currentColor"
        >
          2026-05-28
        </text>
      </g>

      {/* ----- RIGHT side callouts: vat + total (total is the LIME focal point) ----- */}

      {/* Bracket pointing AT the vat row */}
      <g
        className="text-ink-300"
        strokeWidth="1.2"
        opacity="0.7"
        vectorEffect="non-scaling-stroke"
      >
        <path
          className="stroke-current"
          d="M358 232 L382 232 L382 200 L420 200"
        />
      </g>
      {/* VAT chip */}
      <g
        className="text-ink-0"
        strokeWidth="1.2"
        opacity="0.85"
        vectorEffect="non-scaling-stroke"
      >
        <rect
          className="stroke-current"
          x="420"
          y="186"
          width="100"
          height="28"
          rx="4"
          opacity="0.55"
        />
        <text
          x="432"
          y="198"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="9"
          fill="currentColor"
          opacity="0.55"
        >
          vat (15%)
        </text>
        <text
          x="432"
          y="210"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="10"
          fill="currentColor"
        >
          R 18.45
        </text>
      </g>

      {/* Bracket pointing AT the TOTAL row — LIME focal point */}
      <g
        className="text-accent"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      >
        <path
          className="stroke-current"
          d="M362 278 L394 278 L394 318 L424 318"
        />
      </g>
      {/* TOTAL chip — the single lime moment */}
      <g
        className="text-accent"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      >
        <rect
          className="stroke-current"
          x="424"
          y="302"
          width="120"
          height="34"
          rx="5"
        />
        <text
          x="436"
          y="316"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="9"
          fill="currentColor"
          opacity="0.85"
        >
          total
        </text>
        <text
          x="436"
          y="330"
          fontFamily="ui-monospace,SFMono-Regular,Menlo,monospace"
          fontSize="12"
          fontWeight="600"
          fill="currentColor"
        >
          R 141.45
        </text>
        {/* Confidence dot */}
        <circle
          className="fill-current"
          cx="534"
          cy="312"
          r="3"
          stroke="none"
        />
      </g>

      {/* ----- Subtle scan trace: faint horizontal line crossing the receipt ----- */}
      <g
        className="text-ink-0"
        strokeWidth="1"
        opacity="0.25"
        vectorEffect="non-scaling-stroke"
      >
        <line
          className="stroke-current"
          x1="234"
          y1="378"
          x2="368"
          y2="372"
          strokeDasharray="1 4"
        />
      </g>
    </svg>
  );
}
