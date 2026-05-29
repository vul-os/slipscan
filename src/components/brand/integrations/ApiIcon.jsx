/**
 * API icon — a custom "chip" mark representing a REST API / developer integration.
 * Uses currentColor so it inherits the surrounding text colour (ink-400 → ink-600 on hover).
 *
 * Design: a rounded square microchip silhouette with "</>" code brackets inside,
 * plus four "pin" stubs on each side — a classic developer/API visual.
 */
export default function ApiIcon({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      role="img"
      fill="currentColor"
      className={className}
    >
      {/* Chip body — rounded square */}
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" opacity="0.15" />
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />

      {/* Left side pins */}
      <line x1="2" y1="8.5"  x2="5" y2="8.5"  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="12"   x2="5" y2="12"   stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="15.5" x2="5" y2="15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />

      {/* Right side pins */}
      <line x1="19" y1="8.5"  x2="22" y2="8.5"  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="19" y1="12"   x2="22" y2="12"   stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="19" y1="15.5" x2="22" y2="15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />

      {/* "</>" brackets — code symbol inside the chip */}
      {/* < */}
      <path
        d="M9.5 9.5 L7.5 12 L9.5 14.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* > */}
      <path
        d="M14.5 9.5 L16.5 12 L14.5 14.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* / */}
      <line
        x1="13"
        y1="9.5"
        x2="11"
        y2="14.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
