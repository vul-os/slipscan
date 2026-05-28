import { Reveal, RevealGroup } from "@/components/landing/motion";

const QUOTES = [
  {
    quote:
      "We process about 200 supplier slips a month. slip/scan cut that work from two days to about an hour. The Xero push just works.",
    name: "Lerato Mokoena",
    role: "Bookkeeper, Halfway Ledger",
    initials: "LM",
  },
  {
    quote:
      "What sold us was the learning loop. We corrected coffee-shop vendors once on day one; by day three it was pre-classifying everything we throw at it.",
    name: "Sam de Wet",
    role: "Operations, Veld Studio",
    initials: "SD",
  },
  {
    quote:
      "Auto-reconcile against our Stitch feed is the feature I didn't know I was waiting for. Sundays got their afternoons back.",
    name: "Naledi Sithole",
    role: "Co-founder, Indlovu Logistics",
    initials: "NS",
  },
];

export default function Testimonials() {
  return (
    <section id="testimonials" className="bg-ink-0 py-24 lg:py-32">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
        {/* Headline */}
        <Reveal>
          <div className="max-w-3xl mb-12 lg:mb-16">
            <p className="label-eyebrow">In their words</p>
            <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.1] tracking-tightest text-ink-900">
              What teams say after a week of it.
            </h2>
            <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink-500">
              Early customers running real books, not staged demos.
            </p>
          </div>
        </Reveal>

        {/* Quote cards */}
        <RevealGroup
          stagger={80}
          className="grid grid-cols-1 md:grid-cols-3 gap-6"
        >
          {QUOTES.map((item) => (
            <div
              key={item.name}
              className="p-8 rounded-xl bg-ink-0 border border-ink-200 flex flex-col"
            >
              {/* Quote glyph */}
              <p
                className="font-mono text-[64px] leading-none text-accent-ring/40 -mt-2 mb-1 select-none"
                aria-hidden
              >
                &ldquo;
              </p>

              {/* Quote text */}
              <blockquote className="text-[15px] leading-relaxed text-ink-700 flex-1">
                {item.quote}
              </blockquote>

              {/* Attribution */}
              <footer className="mt-6 flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-full bg-ink-900 text-accent text-[11px] font-medium flex items-center justify-center shrink-0 select-none"
                  aria-hidden
                >
                  {item.initials}
                </div>
                <div>
                  <p className="text-[13px] font-medium text-ink-900">{item.name}</p>
                  <p className="text-[12px] text-ink-500">{item.role}</p>
                </div>
              </footer>
            </div>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
