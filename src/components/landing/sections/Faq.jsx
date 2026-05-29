import { Link } from "react-router-dom";
import { Reveal } from "@/components/landing/motion";
import { ChevronDown } from "lucide-react";

const FAQS = [
  {
    q: "How accurate is the extraction?",
    a: "On clean PDFs we land above 98% field-level. On crumpled thermal-print slips, expect 92–96% on totals and dates, with confidence scores that flag anything we're not sure about. Every field is editable in one keystroke.",
  },
  {
    q: "What happens to my receipts and bank data?",
    a: (
      <>
        Documents live in Cloudflare R2 in your region. Bank-feed credentials are held by Stitch,
        not us — we receive read-only transaction data. Neon Postgres is row-level-security tenanted,
        so your org is invisible to every other org on the platform. Full detail in our{" "}
        <Link
          to="/docs/security"
          className="underline decoration-ink-300 hover:decoration-ink-700"
        >
          security page
        </Link>
        .
      </>
    ),
  },
  {
    q: "Do I have to leave Xero?",
    a: "No. We're a capture-and-reconcile layer first. Connect your Xero org, work in slip/scan, and we push journals and bills through. Move your ledger over only when you're ready — or never.",
  },
  {
    q: "Does it work for personal finance?",
    a: "Yes. Create a personal org during onboarding and you get a household-style spending breakdown over your bank feeds and emailed slips. Same engine, different surface.",
  },
  {
    q: "Which banks do you support?",
    a: "Via Stitch, all major SA retail and business banks: Standard Bank, FNB, ABSA, Nedbank, Capitec, Investec, Discovery, TymeBank. International is on the roadmap once we have parity.",
  },
  {
    q: "Can I email receipts in?",
    a: (
      <>
        Every org gets a unique address —{" "}
        <code className="font-mono text-[13px] bg-ink-100 text-ink-900 px-1.5 py-0.5 rounded">
          &lt;your-slug&gt;@mail.slipscan.app
        </code>
        . Forward any receipt; we&apos;ll process it and slot it into your inbox. CC the address on outgoing supplier orders and you&apos;ll never chase another receipt.
      </>
    ),
  },
  {
    q: "How does pricing work in early access?",
    a: "Everything is free, no card. When we turn on billing, you'll get 30 days notice, and any data, classifiers, and rules you've built stay yours.",
  },
  {
    q: "Can my accountant see all my clients in one place?",
    a: "Yes. The Business tier ships an accountant workspace: one attention queue across every client org, with forecast, anomalies, and tax-readiness scoring per client.",
  },
];

export default function Faq() {
  return (
    <section id="faq" className="bg-ink-50 py-24 lg:py-32">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
        {/* Headline */}
        <Reveal>
          <div className="max-w-3xl mb-12 lg:mb-16">
            <p className="label-eyebrow">Questions</p>
            <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.1] tracking-tightest text-ink-900">
              The honest answers.
            </h2>
            <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink-500">
              If we haven&apos;t covered it, ask us at{" "}
              <a
                href="mailto:hello@slipscan.app"
                className="underline decoration-ink-300 hover:decoration-ink-700 transition-colors"
              >
                hello@slipscan.app
              </a>
              .
            </p>
          </div>
        </Reveal>

        {/* FAQ grid */}
        <Reveal>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-0">
            {FAQS.map((item) => (
              <details
                key={item.q}
                className="group border-t border-ink-200 last:border-b"
              >
                <summary className="flex items-center justify-between gap-4 py-5 cursor-pointer list-none select-none hover:text-ink-900 transition-colors">
                  <span className="text-[15px] font-medium text-ink-900">{item.q}</span>
                  <ChevronDown
                    size={16}
                    className="text-ink-400 shrink-0 transition-transform duration-200 ease-out-cubic group-open:rotate-180"
                  />
                </summary>
                {/* CSS grid transition for open/close */}
                <div className="grid transition-all duration-[250ms] ease-out-cubic grid-rows-[0fr] group-open:grid-rows-[1fr]">
                  <div className="overflow-hidden">
                    <p className="pb-5 text-[14px] leading-relaxed text-ink-500">{item.a}</p>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
