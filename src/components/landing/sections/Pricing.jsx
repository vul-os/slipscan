import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { RevealGroup } from "@/components/landing/motion";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const TIERS = [
  {
    name: "Free",
    price: "R0",
    tagline: "Solo, side-hustles, getting started.",
    features: [
      "Up to 50 documents / mo",
      "1 user, 1 org",
      "Personal vault + business ledger",
      "Email-in (1 inbox alias)",
      "Xero export",
    ],
    ctaLabel: "Start free →",
    ctaVariant: "secondary",
    ctaHref: "/register",
    highlighted: false,
  },
  {
    name: "Team",
    price: "R249",
    tagline: "SMBs running the books in-house.",
    features: [
      "Up to 500 documents / mo",
      "5 users, 3 orgs",
      "Auto-reconcile with Stitch feeds",
      "Slack approvals",
      "Classification learning loop",
      "Priority email support",
    ],
    ctaLabel: "Start Team trial →",
    ctaVariant: "accent",
    ctaHref: "/register?plan=team",
    highlighted: true,
  },
  {
    name: "Business",
    price: "R599",
    tagline: "Bookkeepers & accountants with clients.",
    features: [
      "Up to 2,500 documents / mo",
      "Unlimited users, unlimited orgs",
      "Accountant workspace (one inbox across all clients)",
      "Forecast, anomalies, tax-readiness",
      "Public API + tokens",
      "Audit log export",
    ],
    ctaLabel: "Talk to us →",
    ctaVariant: "secondary",
    ctaHref: "mailto:hello@slipscan.app",
    highlighted: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="bg-ink-50 py-24 lg:py-32">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
        {/* Headline */}
        <div className="max-w-3xl mx-auto text-center mb-12 lg:mb-16">
          <p className="label-eyebrow !text-accent-ring">Pricing</p>
          <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.1] tracking-tightest text-ink-900">
            One price. Every kind of money.
          </h2>
          <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink-500">
            Free during early access. When we charge, it&apos;ll be one transparent monthly price, ZAR-first, with predictable per-document overages.
          </p>
        </div>

        {/* Pricing cards */}
        <RevealGroup
          stagger={80}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start"
        >
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={cn(
                "bg-ink-0 rounded-xl border p-8 flex flex-col transition-colors",
                tier.highlighted
                  ? "border-accent ring-1 ring-accent ring-offset-2 ring-offset-ink-50 shadow-card-hover"
                  : "border-ink-200 hover:border-ink-300",
              )}
            >
              {/* Tier name */}
              <p className="text-[13px] font-medium text-ink-500 uppercase tracking-[0.06em]">
                {tier.name}
              </p>

              {/* Price */}
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-[40px] font-medium tracking-tightest text-ink-900 tnum leading-none">
                  {tier.price}
                </span>
                <span className="text-base text-ink-400">/ mo</span>
              </div>

              {/* Tagline */}
              <p className="mt-3 text-[13px] italic text-ink-500">{tier.tagline}</p>

              {/* Divider */}
              <div className="mt-6 border-t border-ink-100" />

              {/* Features */}
              <ul className="mt-6 space-y-3 flex-1">
                {tier.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5">
                    <Check size={14} className="text-accent-ring mt-0.5 shrink-0" />
                    <span className="text-[13px] text-ink-600 leading-snug">{feat}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <div className="mt-8">
                {tier.ctaHref.startsWith("mailto:") ? (
                  <a href={tier.ctaHref} className="block w-full">
                    <Button variant={tier.ctaVariant} size="md" className="w-full">
                      {tier.ctaLabel}
                    </Button>
                  </a>
                ) : (
                  <Link to={tier.ctaHref} className="block w-full">
                    <Button variant={tier.ctaVariant} size="md" className="w-full">
                      {tier.ctaLabel}
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          ))}
        </RevealGroup>

        {/* Footnote */}
        <p className="mt-8 text-[12px] text-ink-500 text-center">
          Free during early access — no card required. Prices shown are forward-looking and may change.
        </p>
      </div>
    </section>
  );
}
