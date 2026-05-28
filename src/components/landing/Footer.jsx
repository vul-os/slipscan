import { Link } from "react-router-dom";
import { Github, Twitter, Linkedin } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";

const LINKS = {
  Product: [
    { label: "Features", href: "/#features", internal: true },
    { label: "How it works", href: "/#how-it-works", internal: true },
    { label: "Pricing", href: "/#pricing", internal: true },
    { label: "Integrations", href: "/#integrations", internal: true },
    { label: "Live demo", href: "/#live-demo", internal: true },
    { label: "Changelog", href: "/changelog", internal: true },
  ],
  Company: [
    { label: "About", href: "/about", internal: true },
    { label: "Roadmap", href: "/roadmap", internal: true },
    { label: "Careers", href: "/careers", internal: true },
    { label: "Contact", href: "mailto:hello@slipscan.app", internal: false },
    { label: "Brand assets", href: "/brand", internal: true },
  ],
  Resources: [
    { label: "Docs", href: "/docs", internal: true },
    { label: "Quickstart", href: "/docs/quickstart", internal: true },
    { label: "API reference", href: "/docs/api", internal: true },
    { label: "Status", href: "https://status.slipscan.app", internal: false },
  ],
  Legal: [
    { label: "Terms", href: "/legal/terms", internal: true },
    { label: "Privacy", href: "/legal/privacy", internal: true },
    { label: "DPA", href: "/legal/dpa", internal: true },
    { label: "Security", href: "/docs/security", internal: true },
    { label: "POPIA compliance", href: "/legal/popia", internal: true },
  ],
};

export default function Footer() {
  return (
    <footer className="bg-ink-950 text-ink-300 border-t border-ink-0/8">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-12 py-16 lg:py-20">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12 lg:gap-16">
          {/* Wordmark column */}
          <div className="flex flex-col gap-4">
            <Link to="/" aria-label="slip/scan home" className="inline-flex items-center py-1.5">
              <Wordmark size="md" tone="dark" />
            </Link>
            <p className="text-[13px] text-ink-400 leading-relaxed">
              Receipts, structured. Books, lighter.
            </p>
            <a
              href="mailto:hello@slipscan.app"
              className="inline-flex items-center py-2.5 text-[13px] text-ink-200 hover:text-ink-0 transition-colors"
            >
              hello@slipscan.app
            </a>
            {/* Social icons */}
            <div className="flex items-center gap-1 mt-1">
              <a
                href="https://github.com/slipscan"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="inline-flex items-center justify-center w-10 h-10 text-ink-400 hover:text-ink-0 transition-colors"
              >
                <Github size={16} />
              </a>
              <a
                href="https://twitter.com/slipscan"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="X / Twitter"
                className="inline-flex items-center justify-center w-10 h-10 text-ink-400 hover:text-ink-0 transition-colors"
              >
                <Twitter size={16} />
              </a>
              <a
                href="https://linkedin.com/company/slipscan"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="LinkedIn"
                className="inline-flex items-center justify-center w-10 h-10 text-ink-400 hover:text-ink-0 transition-colors"
              >
                <Linkedin size={16} />
              </a>
            </div>
          </div>

          {/* Link columns */}
          <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-8">
            {Object.entries(LINKS).map(([group, links]) => (
              <div key={group}>
                <p className="label-eyebrow !text-ink-500 mb-3">{group}</p>
                <ul className="space-y-2">
                  {links.map((link) => (
                    <li key={link.label}>
                      {link.internal ? (
                        <Link
                          to={link.href}
                          className="block py-1 text-[13px] text-ink-300 hover:text-ink-0 transition-colors"
                        >
                          {link.label}
                        </Link>
                      ) : (
                        <a
                          href={link.href}
                          target={link.href.startsWith("http") ? "_blank" : undefined}
                          rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined}
                          className="block py-1 text-[13px] text-ink-300 hover:text-ink-0 transition-colors"
                        >
                          {link.label}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom row */}
        <div className="pt-12 mt-12 border-t border-ink-0/8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <p className="text-[12px] text-ink-500">
            © 2026 slip/scan. Cape Town, South Africa.
          </p>
          <span className="font-mono text-[11px] border border-ink-0/10 rounded px-2 py-1 text-ink-400">
            ZAR · Africa/Johannesburg
          </span>
        </div>
      </div>
    </footer>
  );
}
