import { createElement, useEffect, useRef, useState } from "react";
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

export default function Reveal({
  as = "div",
  delay = 0,
  className,
  children,
  ...rest
}) {
  const ref = useRef(null);
  const [revealed, setRevealed] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (revealed) return;
    const node = ref.current;
    const observer = getObserver();
    if (!node || !observer) {
      setRevealed(true);
      return;
    }
    callbacks.set(node, () => setRevealed(true));
    observer.observe(node);
    return () => {
      observer.unobserve(node);
      callbacks.delete(node);
    };
  }, [revealed]);

  return createElement(
    as,
    {
      ref,
      "data-reveal": "",
      "data-revealed": revealed ? "true" : undefined,
      style: delay ? { transitionDelay: delay + "ms" } : undefined,
      className: cn(
        "opacity-0 translate-y-2 transition-[opacity,transform] duration-300 ease-out-cubic",
        "data-[revealed=true]:opacity-100 data-[revealed=true]:translate-y-0",
        className,
      ),
      ...rest,
    },
    children,
  );
}
