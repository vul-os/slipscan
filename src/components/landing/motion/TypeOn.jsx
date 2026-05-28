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

export default function TypeOn({
  text = "",
  speed = 40,
  caret = true,
  className,
}) {
  const ref = useRef(null);
  const reducedRef = useRef(false);
  const [rendered, setRendered] = useState(() => {
    const reduced = prefersReducedMotion();
    reducedRef.current = reduced;
    return reduced ? text : "";
  });
  const [done, setDone] = useState(() => reducedRef.current);

  useEffect(() => {
    if (reducedRef.current) {
      setRendered(text);
      setDone(true);
      return;
    }

    const node = ref.current;
    const observer = getObserver();
    if (!node || !observer) {
      setRendered(text);
      setDone(true);
      return;
    }

    let timer = 0;
    let cancelled = false;

    const begin = () => {
      let i = 0;
      const step = () => {
        if (cancelled) return;
        i += 1;
        setRendered(text.slice(0, i));
        if (i < text.length) {
          timer = window.setTimeout(step, speed);
        } else {
          setDone(true);
        }
      };
      step();
    };

    callbacks.set(node, begin);
    observer.observe(node);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      observer.unobserve(node);
      callbacks.delete(node);
    };
  }, [text, speed]);

  return (
    <span ref={ref} className={cn(className)}>
      {rendered}
      {caret && !reducedRef.current && !done && (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block w-[2px] h-[1em] align-[-0.15em] bg-current animate-pulse"
        />
      )}
    </span>
  );
}
