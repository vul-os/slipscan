import { Marquee } from "@/components/landing/motion";

const NAMES = [
  { glyph: "◆", name: "Halfway Ledger" },
  { glyph: "▲", name: "Veld Studio" },
  { glyph: "●", name: "Two Rivers Accounting" },
  { glyph: "■", name: "Kopano Coop" },
  { glyph: "✦", name: "Indlovu Logistics" },
];

export default function SocialProof() {
  return (
    <section
      id="social-proof"
      className="relative border-t border-ink-0/5 bg-ink-950 overflow-hidden"
    >
      <div className="h-20 lg:h-24 flex items-center">
        {/* Left eyebrow with fade veil */}
        <div className="relative shrink-0 z-10 pl-5 sm:pl-8 lg:pl-12 pr-0">
          <p className="label-eyebrow !text-ink-400 whitespace-nowrap">
            Trusted by finance teams across SA
          </p>
          {/* Fade veil so logos disappear cleanly under the eyebrow */}
          <div
            className="absolute inset-y-0 right-0 w-20 pointer-events-none"
            style={{
              background: "linear-gradient(to right, rgb(9 9 11) 0%, transparent 100%)",
            }}
            aria-hidden
          />
        </div>

        {/* Marquee track */}
        <div className="relative flex-1 min-w-0 overflow-hidden">
          {/* Left veil */}
          <div
            className="absolute left-0 inset-y-0 w-20 z-10 pointer-events-none"
            style={{
              background: "linear-gradient(to right, rgb(9 9 11) 0%, transparent 100%)",
            }}
            aria-hidden
          />
          {/* Right veil */}
          <div
            className="absolute right-0 inset-y-0 w-20 z-10 pointer-events-none"
            style={{
              background: "linear-gradient(to left, rgb(9 9 11) 0%, transparent 100%)",
            }}
            aria-hidden
          />

          <Marquee speed="40s" pauseOnHover>
            {NAMES.map((item) => (
              <span
                key={item.name}
                className="inline-flex items-center gap-2 mx-8 text-[15px] font-mono tracking-tight text-ink-0/55 hover:text-ink-0/85 transition-colors duration-200 select-none"
              >
                <span aria-hidden className="text-ink-0/30">{item.glyph}</span>
                {item.name}
              </span>
            ))}
          </Marquee>
        </div>
      </div>
    </section>
  );
}
