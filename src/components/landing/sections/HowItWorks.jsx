import { Link } from "react-router-dom";
import { Reveal, RevealGroup } from "@/components/landing/motion";
import { I1_DropIn, I2_Extract, I3_Verify } from "@/components/landing/illustrations";

const STEPS = [
  {
    number: "01",
    title: "Drop it in.",
    body: (
      <>
        Photo from your phone, a PDF from your inbox, a forwarded email to{" "}
        <span className="font-mono text-[13px] text-ink-700 break-all">you@mail.slipscan.app</span>
        , or a folder of statements. We take it any way you have it.
      </>
    ),
    chips: ["Mobile photo", "Email-in", "PDF", "CSV", "Bank statement"],
    Illustration: I1_DropIn,
  },
  {
    number: "02",
    title: "We read every line.",
    body: "Gemini-powered extraction pulls vendor, date, totals, line items, tax, FX rate, and payment method — even from crumpled thermal slips. Confidence scores on every field.",
    chips: ["Vendor", "Line items", "VAT", "FX", "Confidence"],
    Illustration: I2_Extract,
  },
  {
    number: "03",
    title: "Confirm and post.",
    body: "Skim the extracted fields, fix anything we got wrong, and we learn — per-team and across the platform. Then it's posted to your ledger or pushed to Xero.",
    chips: ["Auto-classify", "Learn", "Xero push", "Reconcile"],
    Illustration: I3_Verify,
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="relative bg-ink-0">
      {/* Gradient seam from the dark social-proof band above */}
      <div
        className="h-6 w-full pointer-events-none"
        style={{
          background: "linear-gradient(to bottom, rgb(9 9 11) 0%, rgb(255 255 255) 100%)",
        }}
        aria-hidden
      />

      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12 py-20 lg:py-28">
        {/* Headline block */}
        <Reveal>
          <div className="max-w-3xl mb-16 lg:mb-20">
            <p className="label-eyebrow">How it works</p>
            <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.1] tracking-tightest text-ink-900">
              Three steps. About sixty seconds.
            </h2>
            <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink-500 max-w-2xl">
              Drop in a slip from your phone, your inbox, or a folder. We read it, you confirm it, and it&apos;s in your books — categorised, FX-converted, and ready to reconcile.
            </p>
          </div>
        </Reveal>

        {/* Steps grid with connector line */}
        <div className="relative">
          {/* Dashed connector line — lg+ only, behind cards */}
          <Reveal>
            <div
              className="hidden lg:block absolute top-[5.5rem] left-[calc(16.66%+1rem)] right-[calc(16.66%+1rem)] h-px border-t border-dashed border-ink-200 z-0"
              aria-hidden
            >
              {/* Node at card 2 */}
              <span className="absolute left-[calc(50%-3px)] top-[-3px] w-1.5 h-1.5 rounded-full bg-accent" />
              {/* Node at card 3 */}
              <span className="absolute right-0 top-[-3px] w-1.5 h-1.5 rounded-full bg-accent" />
            </div>
          </Reveal>

          <RevealGroup stagger={80} className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-8 lg:gap-10">
            {STEPS.map((step) => (
              <div key={step.number} className="group flex flex-col">
                {/* Illustration */}
                <div className="flex items-center justify-center h-44 sm:h-52 mb-6">
                  <step.Illustration className="w-full max-w-[280px] h-full text-ink-900 transition-opacity duration-300 group-hover:opacity-90" />
                </div>

                {/* Step number */}
                <p className="font-mono text-[56px] leading-none text-ink-200 tnum mb-3">
                  {step.number}
                </p>

                {/* Title */}
                <h3 className="text-[20px] font-medium tracking-tight text-ink-900 mb-2">
                  {step.title}
                </h3>

                {/* Body */}
                <p className="text-[15px] leading-relaxed text-ink-500 mb-5 flex-1">
                  {step.body}
                </p>

                {/* Chip row */}
                <div className="flex flex-wrap gap-1.5">
                  {step.chips.map((chip) => (
                    <span
                      key={chip}
                      className="border border-ink-200 rounded text-[11px] px-2 py-1 text-ink-600"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </RevealGroup>
        </div>

        {/* Bottom CTA */}
        <div className="mt-12 lg:mt-16 flex justify-center">
          <Link
            to="/docs/quickstart"
            className="inline-flex items-center py-2.5 px-1 text-[14px] text-ink-600 hover:text-ink-900 transition-colors underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700"
          >
            See a full walk-through →
          </Link>
        </div>
      </div>
    </section>
  );
}
