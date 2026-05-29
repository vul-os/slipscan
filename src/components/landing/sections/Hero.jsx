import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { AuroraBg } from "@/components/landing/motion";
import HeroIllustration from "@/components/landing/illustrations/HeroIllustration.jsx";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/cn";

export default function Hero() {
  const isAuthed = !!useAuthStore((s) => s.accessToken);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function onCtaSubmit(e) {
    e.preventDefault();
    if (isAuthed) {
      navigate("/dashboard");
      return;
    }
    const qs = email ? `?email=${encodeURIComponent(email)}` : "";
    navigate(`/register${qs}`);
  }

  const ctaLabel = isAuthed ? "Open dashboard" : "Get started — free";

  return (
    <section
      id="hero"
      className="relative h-screen h-[100svh] overflow-hidden bg-black flex flex-col"
      aria-label="slip/scan — receipts, structured"
    >
      {/* Ambient aurora + grain (sits behind photo + lime radial) */}
      <AuroraBg variant="hero" />

      <HeroIllustration
        className={cn(
          "hidden lg:block",
          "absolute right-0 top-1/2 -translate-y-1/2",
          "w-[58%] xl:w-[55%] max-w-none",
          "select-none pointer-events-none",
          "text-ink-0",
        )}
      />

      <div
        className="absolute inset-0 hidden lg:block pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, rgb(0 0 0) 0%, rgb(0 0 0 / 0.92) 28%, rgb(0 0 0 / 0.55) 55%, rgb(0 0 0 / 0.15) 78%, rgb(0 0 0 / 0) 100%)",
        }}
        aria-hidden
      />

      <div
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 32% 28% at 84% 54%, rgb(200 255 0 / 0.55) 0%, transparent 65%)",
        }}
        aria-hidden
      />

      <div className="relative z-10 flex-1 min-h-0 flex items-center pt-16 sm:pt-20 lg:pt-20 pb-4 lg:pb-0">
        <div className="w-full max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
          <div className="max-w-xl lg:max-w-2xl">
            <p className="label-eyebrow !text-accent !text-[12px]">
              AI receipt extraction
            </p>

            <h1
              className={cn(
                "mt-4 sm:mt-5 font-medium leading-[1.04] tracking-[-0.035em] text-ink-0",
                "text-[2rem] xs:text-[2.25rem] sm:text-[3rem] lg:text-[4rem] xl:text-[4.75rem]",
                "[text-shadow:0_2px_24px_rgb(0_0_0_/_0.4)]",
              )}
            >
              Drop in a slip.{" "}
              <span className="text-accent">We&apos;ll do the rest.</span>
            </h1>

            <p className="mt-4 sm:mt-6 max-w-xl text-[15px] sm:text-lg leading-relaxed text-ink-300">
              Snap, scan, and verify. slip/scan turns crumpled receipts into
              clean, queryable data your team can actually use.
            </p>

            <form
              onSubmit={onCtaSubmit}
              className="mt-5 sm:mt-8 flex w-full max-w-md flex-col gap-2 sm:flex-row"
            >
              <label htmlFor="hero-email" className="sr-only">Work email</label>
              {!isAuthed && (
                <input
                  id="hero-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="What's your work email?"
                  autoComplete="email"
                  className={cn(
                    "h-11 sm:h-12 sm:flex-1 w-full rounded-md px-4 text-sm outline-none",
                    "bg-ink-0/5 border border-ink-0/20 backdrop-blur",
                    "text-ink-0 placeholder:text-ink-400",
                    "transition-colors duration-150",
                    "hover:border-ink-0/30",
                    "focus:border-accent/70 focus:bg-ink-0/10 focus:shadow-focus",
                  )}
                />
              )}
              <Button type="submit" variant="accent" size="lg" className="h-11 sm:h-12 group">
                {ctaLabel}
                <ArrowRight
                  size={16}
                  className="transition-transform duration-200 ease-out-cubic group-hover:translate-x-0.5"
                />
              </Button>
            </form>

            <p className="mt-3 sm:mt-4 text-[11px] sm:text-[12px] text-ink-400 tracking-tight">
              Free during early access · No credit card required
            </p>
          </div>
        </div>
      </div>

      <div className="lg:hidden relative shrink-0 w-full">
        <div
          className="absolute inset-x-0 -top-px h-16 pointer-events-none z-10"
          style={{
            background: "linear-gradient(180deg, rgb(0 0 0) 0%, rgb(0 0 0 / 0) 100%)",
          }}
          aria-hidden
        />
        <HeroIllustration className="block w-full h-auto text-ink-0 select-none pointer-events-none" />
      </div>

      {/* Scroll hint — visible on lg+, hidden once user scrolls past 80px */}
      <div
        className={cn(
          "hidden lg:flex absolute bottom-8 left-1/2 -translate-x-1/2 z-10",
          "flex-col items-center gap-1 pointer-events-none",
          "transition-opacity duration-300",
          scrolled ? "opacity-0" : "opacity-100",
        )}
        aria-hidden
      >
        <div
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center",
            "border border-ink-0/8 text-ink-400",
            "animate-bounce-soft motion-reduce:animate-none",
          )}
        >
          <ChevronDown size={14} />
        </div>
      </div>
    </section>
  );
}
