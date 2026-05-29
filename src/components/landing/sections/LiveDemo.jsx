import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Reveal, AuroraBg } from "@/components/landing/motion";
import { Button } from "@/components/ui/Button";
import ScreenshotCarousel from "./ScreenshotCarousel";

export default function LiveDemo() {
  return (
    <section id="screenshots" className="relative bg-ink-950 py-28 lg:py-40 overflow-hidden">
      {/* Ambient aurora + grain */}
      <AuroraBg variant="demo" />

      {/* Lime radial */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 30% 40% at 75% 35%, rgb(200 255 0 / 0.20) 0%, transparent 65%)",
        }}
        aria-hidden
      />

      <div className="relative z-10 max-w-7xl mx-auto px-5 sm:px-8 lg:px-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
          {/* Left — copy (above carousel on mobile, left column on lg) */}
          <div className="lg:col-span-5 order-1 lg:order-1">
            <Reveal>
              <p className="label-eyebrow !text-accent">Watch it work</p>
              <h2 className="mt-3 text-[2rem] sm:text-[2.5rem] lg:text-[2.75rem] font-medium leading-[1.1] tracking-tightest text-ink-0">
                Paper in. Posted in seconds.
              </h2>
              <p className="mt-4 text-[15px] sm:text-[16px] leading-relaxed text-ink-400 max-w-md">
                Every surface, every workflow. Six screens from the actual app — captured live, no
                marketing mock-ups.
              </p>

              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Button variant="accent" size="lg" asChild>
                  <Link to="/register">
                    Get started — free
                    <ArrowRight size={16} />
                  </Link>
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  asChild
                  className="border-ink-0/20 text-ink-0 bg-transparent hover:bg-ink-0/8"
                >
                  <Link to="/docs/quickstart">Read the quickstart</Link>
                </Button>
              </div>
            </Reveal>
          </div>

          {/* Right — screenshot carousel (below copy on mobile, right column on lg) */}
          <div className="lg:col-span-7 order-2 lg:order-2">
            <ScreenshotCarousel />
          </div>
        </div>
      </div>
    </section>
  );
}
