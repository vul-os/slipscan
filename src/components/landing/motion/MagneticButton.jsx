import { useEffect, useRef, useState } from "react";
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

const RADIUS = 100;

export default function MagneticButton({
  strength = 0.15,
  className,
  children,
}) {
  const ref = useRef(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || typeof window === "undefined") return;
    const node = ref.current;
    if (!node) return;

    let active = false;

    const onMove = (e) => {
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);

      if (dist < RADIUS) {
        if (!active) {
          node.style.transition = "transform 120ms cubic-bezier(0.22, 1, 0.36, 1)";
          active = true;
        }
        node.style.transform = `translate3d(${dx * strength}px, ${dy * strength}px, 0)`;
      } else if (active) {
        active = false;
        node.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
        node.style.transform = "translate3d(0, 0, 0)";
      }
    };

    const onLeave = () => {
      if (!active) return;
      active = false;
      node.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
      node.style.transform = "translate3d(0, 0, 0)";
    };

    document.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);

    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      node.style.transform = "";
      node.style.transition = "";
    };
  }, [strength, reduced]);

  return (
    <div ref={ref} className={cn("inline-block will-change-transform", className)}>
      {children}
    </div>
  );
}
