import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Parallax } from "@/components/landing/motion";

const SLIDES = [
  { id: "dashboard",  src: "/images/app/dashboard.png",      alt: "slip/scan dashboard — daily overview" },
  { id: "receipts",   src: "/images/app/receipts.png",       alt: "Receipts table with merchants, totals, and confidence scores" },
  { id: "detail",     src: "/images/app/receipt-detail.png", alt: "Receipt detail with extracted fields and classification" },
  { id: "ledger",     src: "/images/app/ledger.png",         alt: "Chart of accounts in the ledger" },
  { id: "reconcile",  src: "/images/app/reconcile.png",      alt: "Reconciliation queue: matched and needs-review" },
  { id: "ask",        src: "/images/app/ask.png",            alt: "Ask — plain-English queries over your receipts" },
];

const INTERVAL_MS = 4500;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function ScreenshotCarousel() {
  const [active, setActive] = useState(0);
  const containerRef = useRef(null);
  const visibleRef = useRef(true);
  const hoveringRef = useRef(false);
  const reduced = usePrefersReducedMotion();

  // IntersectionObserver — flip visibility ref when off-screen
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => { visibleRef.current = entry.isIntersecting; },
      { threshold: 0.1 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Auto-advance. A single setInterval that ALWAYS re-fires; the visibility
  // / hover check just skips the active update — the loop keeps polling so
  // the carousel resumes the moment the user scrolls back / mouses out.
  useEffect(() => {
    if (reduced) return;
    const handle = setInterval(() => {
      if (!visibleRef.current || hoveringRef.current) return;
      setActive((prev) => (prev + 1) % SLIDES.length);
    }, INTERVAL_MS);
    return () => clearInterval(handle);
  }, [reduced]);

  return (
    <Parallax intensity={3}>
      <div
        ref={containerRef}
        onMouseEnter={() => { hoveringRef.current = true; }}
        onMouseLeave={() => { hoveringRef.current = false; }}
        className="relative"
      >
        {/* Soft lime glow grounding the image on the dark band */}
        <div
          className="absolute -inset-8 bg-accent/[0.08] blur-3xl rounded-full -z-10"
          aria-hidden
        />

        {/* Screenshot stack — raw image, no chrome */}
        <div className="relative w-full aspect-[1440/761] rounded-lg overflow-hidden shadow-[0_30px_80px_-20px_rgb(0_0_0/0.6)] ring-1 ring-ink-0/10">
          {SLIDES.map((slide, i) => (
            <img
              key={slide.id}
              src={slide.src}
              alt={slide.alt}
              loading={i === 0 ? "eager" : "lazy"}
              draggable={false}
              className={cn(
                "absolute inset-0 w-full h-full object-cover object-top select-none",
                "transition-opacity ease-out",
                reduced ? "duration-0" : "duration-700",
                i === active ? "opacity-100" : "opacity-0",
              )}
            />
          ))}
        </div>

        {/* Dot indicators — kept; tiny, functional, no chrome */}
        <div
          className="mt-5 flex items-center justify-center gap-1.5"
          role="tablist"
          aria-label="Product screenshots"
        >
          {SLIDES.map((slide, i) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-label={`Show ${slide.alt}`}
              onClick={() => setActive(i)}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950",
                i === active
                  ? "w-6 bg-accent"
                  : "w-1.5 bg-ink-0/25 hover:bg-ink-0/50",
              )}
            />
          ))}
        </div>
      </div>
    </Parallax>
  );
}
