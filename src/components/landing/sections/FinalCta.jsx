import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Reveal, MagneticButton, AuroraBg } from "@/components/landing/motion";
import { I6_SlipMarkBg } from "@/components/landing/illustrations";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/cn";

export default function FinalCta() {
  const isAuthed = !!useAuthStore((s) => s.accessToken);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");

  function onSubmit(e) {
    e.preventDefault();
    if (isAuthed) {
      navigate("/dashboard");
      return;
    }
    const qs = email ? `?email=${encodeURIComponent(email)}` : "";
    navigate(`/register${qs}`);
  }

  return (
    <section id="cta" className="relative bg-ink-950 py-28 lg:py-40 overflow-hidden">
      {/* Ambient aurora + grain */}
      <AuroraBg variant="cta" />

      {/* Lime radial */}
      <div
        className="absolute inset-0 pointer-events-none animate-lime-pulse motion-reduce:animate-none"
        style={{
          background:
            "radial-gradient(ellipse 40% 60% at 50% 40%, rgb(200 255 0 / 0.20) 0%, transparent 70%)",
        }}
        aria-hidden
      />

      {/* Background mark — I6, faint bottom-right */}
      <div
        className="absolute bottom-0 right-0 w-[480px] h-[480px] pointer-events-none opacity-[0.04] translate-x-[20%] translate-y-[10%]"
        aria-hidden
      >
        <I6_SlipMarkBg className="w-full h-full text-ink-0" />
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-3xl mx-auto px-5 sm:px-8 lg:px-12 text-center">
        <Reveal>
          <h2 className="text-[2.5rem] sm:text-[3rem] lg:text-[3.75rem] font-medium leading-[1.08] tracking-tightest text-ink-0">
            Drop in a slip.
          </h2>
          <p className="text-[2rem] sm:text-[2.5rem] lg:text-[3rem] font-medium leading-[1.08] tracking-tightest text-accent mt-1">
            We&apos;ll do the rest.
          </p>
          <p className="mt-6 text-[16px] sm:text-[17px] leading-relaxed text-ink-400">
            Free during early access. Set up takes about a minute. Bring your messiest folder of slips.
          </p>
        </Reveal>

        <Reveal delay={120}>
          <form
            onSubmit={onSubmit}
            className="mt-8 flex flex-col sm:flex-row gap-2 max-w-md mx-auto"
          >
            <label htmlFor="cta-email" className="sr-only">Work email</label>
            {!isAuthed && (
              <input
                id="cta-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="What's your work email?"
                autoComplete="email"
                className={cn(
                  "h-12 sm:flex-1 w-full rounded-md px-4 text-sm outline-none",
                  "bg-ink-0/5 border border-ink-0/20",
                  "text-ink-0 placeholder:text-ink-500",
                  "transition-colors duration-150",
                  "hover:border-ink-0/30",
                  "focus:border-accent/70 focus:bg-ink-0/10",
                )}
              />
            )}
            <MagneticButton strength={0.15}>
              <button
                type="submit"
                className={cn(
                  "h-12 px-6 rounded-md font-medium text-[15px] tracking-tight",
                  "bg-accent text-accent-fg",
                  "hover:bg-[#D9FF40] active:bg-[#B8EE00]",
                  "transition-colors duration-150",
                  "inline-flex items-center gap-2 whitespace-nowrap",
                )}
              >
                Get started — free
                <ArrowRight size={15} />
              </button>
            </MagneticButton>
          </form>

          {/* Trust chips */}
          <p className="mt-4 text-[11px] text-ink-400 tracking-tight">
            No card required · Cancel anytime · Your data stays in SA
          </p>

          {/* Secondary CTA */}
          <div className="mt-6">
            <a
              href="/docs"
              className="inline-flex items-center py-2.5 px-1 text-[13px] text-ink-500 hover:text-ink-300 transition-colors underline underline-offset-4 decoration-ink-700 hover:decoration-ink-500"
            >
              Or read the docs →
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
