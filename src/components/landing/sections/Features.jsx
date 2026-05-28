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
import {
  I4_PaperToTable,
  I7_ReconcileMatch,
  I8_LearningLoop,
} from "@/components/landing/illustrations";
import { cn } from "@/lib/cn";

const CATEGORY_LABELS = ["?", "Office Supplies", "?", "Travel", "?", "Meals"];

function ClassifyPill() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % CATEGORY_LABELS.length);
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const label = CATEGORY_LABELS[idx];
  const isQuestion = label === "?";

  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-1 rounded-full text-[12px] font-medium transition-all duration-300",
        isQuestion
          ? "bg-ink-100 text-ink-400 border border-ink-200"
          : "bg-accent/15 text-ink-900 border border-accent/30",
      )}
    >
      {label}
    </span>
  );
}

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

        {/* Bento grid */}
        <RevealGroup
          stagger={60}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4"
        >
          {/* Card 1 — Extraction — large, col-span-3 row-span-2 */}
          <div className="lg:col-span-3 lg:row-span-2 bg-ink-0 rounded-xl border border-ink-200 hover:border-ink-300 transition-colors p-8 lg:p-10 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <FileText size={16} className="text-accent-ring" />
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-400">Extraction</span>
            </div>
            <h3 className="text-[20px] lg:text-[22px] font-medium tracking-tight text-ink-900 mb-3">
              Extraction that handles real receipts.
            </h3>
            <p className="text-[14px] lg:text-[15px] leading-relaxed text-ink-500 mb-6">
              Vendor, line items, totals, VAT, FX rate, payment method — pulled from photos, PDFs, and emailed PDFs. Confidence scores on every field, side-by-side with the original.
            </p>
            <div className="flex-1 flex items-end justify-center">
              <I4_PaperToTable className="w-full max-w-sm text-ink-900" />
            </div>
          </div>

          {/* Card 2 — Classification */}
          <div className="lg:col-span-3 bg-ink-0 rounded-xl border border-ink-200 hover:border-ink-300 transition-colors p-6 lg:p-8 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-accent-ring" />
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-400">Classification</span>
              </div>
              <ClassifyPill />
            </div>
            <h3 className="text-[19px] font-medium tracking-tight text-ink-900 mb-3">
              Classification that learns.
            </h3>
            <p className="text-[14px] leading-relaxed text-ink-500 mb-5">
              Correct a category once and we remember — for your team and, with consent, across the platform. Cold-start merchants come in pre-classified after the first user teaches us.
            </p>
            <div className="flex items-end justify-end mt-auto">
              <I8_LearningLoop className="w-24 h-16 text-ink-900" />
            </div>
          </div>

          {/* Card 3 — Reconcile */}
          <div className="lg:col-span-3 bg-ink-0 rounded-xl border border-ink-200 hover:border-ink-300 transition-colors p-6 lg:p-8 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <GitMerge size={16} className="text-accent-ring" />
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-400">Reconcile</span>
            </div>
            <h3 className="text-[19px] font-medium tracking-tight text-ink-900 mb-3">
              Document ↔ bank-feed auto-reconciliation.
            </h3>
            <p className="text-[14px] leading-relaxed text-ink-500 mb-5">
              Stitch-powered SA bank feeds match against extracted slips. We surface the matches; you accept with one keystroke.
            </p>
            <div className="flex items-end justify-end mt-auto">
              <I7_ReconcileMatch className="w-24 h-16 text-ink-900" />
            </div>
          </div>

          {/* Card 4 — Personal + Business vault */}
          <div className="lg:col-span-2 bg-ink-0 rounded-xl border border-ink-200 hover:border-ink-300 transition-colors p-6 flex flex-col">
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
              <Wallet size={16} className="text-accent-ring" />
            </div>
            <h3 className="text-[17px] font-medium tracking-tight text-ink-900 mb-2">
              Personal vault. Business ledger. Same engine.
            </h3>
            <p className="text-[13px] leading-relaxed text-ink-500">
              Vault22-style spending breakdown for personal, Xero-style ledger for business — pick one or run both side by side.
            </p>
            <div className="mt-4 flex gap-1.5 flex-wrap">
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-ink-50 border border-ink-200 text-ink-600">Personal</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-accent/10 border border-accent/20 text-ink-700">Business</span>
            </div>
          </div>

          {/* Card 5 — Ask anything */}
          <div className="lg:col-span-2 bg-ink-0 rounded-xl border border-ink-200 hover:border-ink-300 transition-colors p-6 flex flex-col">
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
              <MessageCircle size={16} className="text-accent-ring" />
            </div>
            <h3 className="text-[17px] font-medium tracking-tight text-ink-900 mb-2">
              Ask anything.
            </h3>
            <p className="text-[13px] leading-relaxed text-ink-500">
              &ldquo;How much did we spend on fuel last quarter?&rdquo; Natural-language queries over your ledger, with sources cited back to the receipts.
            </p>
            <div className="mt-4">
              <span className="text-[11px] font-mono text-ink-400 italic">
                &ldquo;Fuel last quarter?&rdquo;
              </span>
            </div>
          </div>

          {/* Card 6 — Multi-client accountants */}
          <div className="lg:col-span-2 bg-ink-0 rounded-xl border border-ink-200 hover:border-ink-300 transition-colors p-6 flex flex-col">
            <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
              <Users size={16} className="text-accent-ring" />
            </div>
            <h3 className="text-[17px] font-medium tracking-tight text-ink-900 mb-2">
              Multi-client, built for accountants.
            </h3>
            <p className="text-[13px] leading-relaxed text-ink-500">
              One inbox across every client. Forecast, anomalies, and tax-readiness in one view.
            </p>
            <div className="mt-4 flex gap-1.5">
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-ink-50 border border-ink-200 text-ink-600">Business tier</span>
            </div>
          </div>
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
