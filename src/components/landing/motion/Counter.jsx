import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

let sharedObserver = null;
const callbacks = new WeakMap();

function getObserver() {
  if (typeof window === "undefined") return null;
  if (sharedObserver) return sharedObserver;
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const cb = callbacks.get(entry.target);
          if (cb) cb();
          sharedObserver.unobserve(entry.target);
          callbacks.delete(entry.target);
        }
      }
    },
    { threshold: 0.15 },
  );
  return sharedObserver;
}

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function format(value, decimals) {
  if (decimals > 0) return value.toFixed(decimals);
  return Math.round(value).toString();
}

export default function Counter({
  from = 0,
  to = 100,
  duration = 1200,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
}) {
  const ref = useRef(null);
  const reducedRef = useRef(false);
  const [value, setValue] = useState(() => {
    const reduced = prefersReducedMotion();
    reducedRef.current = reduced;
    return reduced ? to : from;
  });

  useEffect(() => {
    if (reducedRef.current) return;
    const node = ref.current;
    const observer = getObserver();
    if (!node || !observer) {
      setValue(to);
      return;
    }

    let raf = 0;
    let start = 0;

    const tick = (now) => {
      if (!start) start = now;
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    const begin = () => {
      raf = requestAnimationFrame(tick);
    };

    callbacks.set(node, begin);
    observer.observe(node);

    return () => {
      cancelAnimationFrame(raf);
      observer.unobserve(node);
      callbacks.delete(node);
    };
  }, [from, to, duration]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {prefix}
      {format(value, decimals)}
      {suffix}
    </span>
  );
}
