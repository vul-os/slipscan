import { createElement, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

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

export default function Parallax({
  as = "div",
  intensity = 6,
  className,
  children,
  ...rest
}) {
  const ref = useRef(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || typeof window === "undefined") return;
    const node = ref.current;
    if (!node) return;

    let raf = 0;
    let pending = false;

    const update = () => {
      pending = false;
      const rect = node.getBoundingClientRect();
      const vpH = window.innerHeight;
      const vpCenter = vpH / 2;
      const elCenter = rect.top + rect.height / 2;
      // Normalize -1..1 across roughly 2 viewport heights of travel,
      // clamped, so far-off elements sit at rest instead of flying away.
      const t = Math.max(-1, Math.min(1, (vpCenter - elCenter) / vpH));
      const y = t * intensity * 5;
      node.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
    };

    const onScroll = () => {
      if (pending) return;
      pending = true;
      raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [intensity, reduced]);

  return createElement(
    as,
    {
      ref,
      className: cn("will-change-transform", className),
      ...rest,
    },
    children,
  );
}
