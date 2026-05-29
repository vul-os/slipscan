import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  FileText,
  Brain,
  GitMerge,
  Wallet,
  MessageCircle,
  Users,
} from "lucide-react";
import { RevealGroup } from "@/components/landing/motion";
import { cn } from "@/lib/cn";

const CATEGORY_LABELS = ["?", "Office Supplies", "?", "Travel", "?", "Meals"];

function ClassifyPill() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % CATEGORY_LABELS.length), 2000);
    return () => clearInterval(id);
  }, []);
  const label = CATEGORY_LABELS[idx];
  const isQuestion = label === "?";
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-medium",
        "transition-all duration-300",
        isQuestion
          ? "bg-ink-100 text-ink-400 border border-ink-200"
          : "bg-accent/15 text-ink-900 border border-accent/30",
      )}
    >
      {label}
    </span>
  );
}

function ReconcileLine() {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-ink-400">
      <span className="px-2 py-0.5 rounded border border-ink-200 bg-ink-50 text-ink-600">slip</span>
      <span className="flex-1 border-t border-dashed border-accent/60 relative">
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-accent flex items-center justify-center text-[8px] text-accent-fg">✓</span>
      </span>
      <span className="px-2 py-0.5 rounded border border-ink-200 bg-ink-50 text-ink-600">feed</span>
    </div>
  );
}

const FEATURES = [
  {
    icon: FileText,
    title: "Extraction that handles real receipts.",
    body: "Vendor, line items, totals, VAT, FX rate, and payment method — pulled from photos, PDFs, and emailed scans. Confidence scores on every field.",
    accent: (
      <div className="flex flex-wrap gap-1.5">
        {["Vendor", "Line items", "VAT", "FX", "Confidence"].map((c) => (
          <span
            key={c}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-ink-200 text-ink-600"
          >
            {c}
          </span>
        ))}
      </div>
    ),
  },
  {
    icon: Brain,
    title: "Classification that learns.",
    body: "Correct a category once and we remember — for your team and, with consent, across the platform. Cold-start merchants come in pre-classified.",
    accent: (
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono text-ink-400">Coffee Shop →</span>
        <ClassifyPill />
      </div>
    ),
  },
  {
    icon: GitMerge,
    title: "Auto-reconciliation against your bank feed.",
    body: "Stitch-powered SA bank feeds match against extracted slips. We surface the matches; you accept with one keystroke.",
    accent: <ReconcileLine />,
  },
  {
    icon: Wallet,
    title: "Personal vault. Business ledger. Same engine.",
    body: "Personal-finance spending breakdown for personal; Xero-style ledger for business — pick one or run both side by side.",
    accent: (
      <div className="flex gap-1.5">
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-ink-200 text-ink-600">Personal</span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-accent/30 bg-accent/10 text-ink-800">Business</span>
      </div>
    ),
  },
  {
    icon: MessageCircle,
    title: "Ask anything.",
    body: "Natural-language queries over your ledger, with sources cited back to the original receipts.",
    accent: (
      <p className="text-[12px] font-mono text-ink-500 italic">
        &ldquo;How much on fuel last quarter?&rdquo;
      </p>
    ),
  },
  {
    icon: Users,
    title: "Multi-client, built for accountants.",
    body: "One inbox across every client. Forecast, anomalies, and tax-readiness in one view.",
    accent: (
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-ink-200 text-ink-600">Business tier</span>
        <span className="text-[11px] text-ink-400 tabular-nums">12 orgs · 1 inbox</span>
      </div>
    ),
  },
];

export default function Features() {
  return (
    <section id="features" className="bg-ink-50 py-24 lg:py-32">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
        {/* Headline block */}
        <div className="max-w-3xl mb-12 lg:mb-16">
          <p className="label-eyebrow">What it does</p>
          <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.1] tracking-tightest text-ink-900">
            One vault for every kind of money.
          </h2>
          <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink-500 max-w-2xl">
            Personal and business in one product. Capture, classify, reconcile, report — and an LLM that gets sharper every time you correct it.
          </p>
        </div>

        {/* Uniform 3 × 2 grid */}
        <RevealGroup
          stagger={60}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 auto-rows-fr"
        >
          {FEATURES.map(({ icon: Icon, title, body, accent }) => (
            <div
              key={title}
              className={cn(
                "group relative bg-ink-0 rounded-xl border border-ink-200 p-6 lg:p-7",
                "flex flex-col h-full",
                "transition-all duration-200 ease-out-cubic",
                "hover:border-ink-300 hover:shadow-card-hover hover:-translate-y-0.5",
              )}
            >
              {/* Icon chip */}
              <div className="w-10 h-10 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center mb-5 shrink-0">
                <Icon size={18} className="text-accent-ring" strokeWidth={1.75} />
              </div>

              {/* Title */}
              <h3 className="text-[17px] lg:text-[18px] font-medium tracking-tight text-ink-900 leading-snug mb-2">
                {title}
              </h3>

              {/* Body — grows to push accent to bottom */}
              <p className="text-[14px] leading-[1.6] text-ink-500 flex-1">
                {body}
              </p>

              {/* Accent footer — equal vertical space across cards */}
              <div className="mt-6 pt-5 border-t border-ink-100">
                {accent}
              </div>
            </div>
          ))}
        </RevealGroup>

        {/* Bottom CTA */}
        <div className="mt-10 lg:mt-12 flex justify-end">
          <Link
            to="/docs/features"
            className="inline-flex items-center py-2.5 px-1 text-[14px] text-ink-600 hover:text-ink-900 transition-colors underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700"
          >
            All features in the docs →
          </Link>
        </div>
      </div>
    </section>
  );
}
