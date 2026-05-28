import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

export default function ScrollProgress({ className }) {
  const ref = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const node = ref.current;
    if (!node) return;

    let raf = 0;
    let pending = false;

    const update = () => {
      pending = false;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      node.style.transform = `scaleX(${ratio})`;
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
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "fixed top-0 left-0 right-0 z-[60] h-0.5 bg-accent origin-left",
        className,
      )}
      style={{ transform: "scaleX(0)" }}
    />
  );
}
