import { Link } from "react-router-dom";
import {
  FileText,
  BookOpen,
  Banknote,
  Mail,
  MessageSquare,
  Folder,
  Zap,
  Terminal,
} from "lucide-react";
import { RevealGroup } from "@/components/landing/motion";
import { cn } from "@/lib/cn";

const TILES = [
  {
    Icon: FileText,
    name: "Xero",
    description: "Push journals & bills",
    status: "Live",
    href: null,
  },
  {
    Icon: BookOpen,
    name: "QuickBooks",
    description: "Coming soon",
    status: "Beta",
    href: null,
  },
  {
    Icon: Banknote,
    name: "Stitch",
    description: "SA bank feeds",
    status: "Live",
    href: null,
  },
  {
    Icon: Mail,
    name: "Gmail",
    description: "Forward slips by email",
    status: "Live",
    href: null,
  },
  {
    Icon: MessageSquare,
    name: "Slack",
    description: "Approvals & alerts",
    status: "Beta",
    href: null,
  },
  {
    Icon: Folder,
    name: "Google Drive",
    description: "Watch a folder",
    status: "Beta",
    href: null,
  },
  {
    Icon: Zap,
    name: "Zapier",
    description: "Webhooks & automations",
    status: "Beta",
    href: null,
  },
  {
    Icon: Terminal,
    name: "API",
    description: "REST + tokens",
    status: "Live",
    href: "/docs/integrations#api",
  },
];

const STATUS_STYLES = {
  Live: "bg-success/10 text-success border border-success/20",
  Beta: "bg-ink-100 text-ink-500 border border-ink-200",
};

export default function Integrations() {
  return (
    <section id="integrations" className="bg-ink-0 py-24 lg:py-32">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
        {/* Headline */}
        <div className="max-w-3xl mx-auto text-center mb-12 lg:mb-16">
          <p className="label-eyebrow">Plays nicely</p>
          <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.1] tracking-tightest text-ink-900">
            Connects to where your money already lives.
          </h2>
          <p className="mt-4 text-[16px] sm:text-[17px] leading-relaxed text-ink-500">
            We&apos;re a capture-and-reconcile layer, not a walled garden. Push to your existing ledger; pull in your bank feeds; loop us into Slack when something needs your eye.
          </p>
        </div>

        {/* Tiles grid */}
        <RevealGroup
          stagger={40}
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4"
        >
          {TILES.map((tile) => {
            const inner = (
              <div
                className={cn(
                  "group aspect-[5/3] flex flex-col items-start justify-between p-5 rounded-lg border border-ink-200 bg-ink-0",
                  "hover:border-ink-300 hover:shadow-card hover:-translate-y-0.5 transition-all duration-200",
                )}
              >
                <tile.Icon size={20} className="text-ink-400 group-hover:text-ink-600 transition-colors" />
                <div className="flex-1 mt-3">
                  <p className="text-[15px] font-medium text-ink-900">{tile.name}</p>
                  <p className="text-[13px] text-ink-500 mt-0.5">{tile.description}</p>
                </div>
                <div className="mt-3 self-end">
                  <span
                    className={cn(
                      "text-[11px] font-medium px-2 py-0.5 rounded-full",
                      STATUS_STYLES[tile.status],
                    )}
                  >
                    {tile.status}
                  </span>
                </div>
              </div>
            );

            return tile.href ? (
              <Link key={tile.name} to={tile.href}>
                {inner}
              </Link>
            ) : (
              <div key={tile.name}>{inner}</div>
            );
          })}
        </RevealGroup>

        {/* Bottom CTA */}
        <div className="mt-10 lg:mt-12 flex justify-end">
          <Link
            to="/docs/integrations"
            className="inline-flex items-center py-2.5 px-1 text-[14px] text-ink-600 hover:text-ink-900 transition-colors underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700"
          >
            See integration docs →
          </Link>
        </div>
      </div>
    </section>
  );
}
