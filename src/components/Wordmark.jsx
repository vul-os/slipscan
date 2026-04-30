import { cn } from "@/lib/cn";

const TEXT_SIZE = {
  xs: "text-sm",
  sm: "text-base",
  md: "text-xl",
  lg: "text-3xl",
};

const MARK_SIZE = {
  xs: 18,
  sm: 22,
  md: 26,
  lg: 36,
};

// Brand lockup. The slash is the mark — paired with a small SVG square so
// the wordmark reads even at small sizes (sidebar, favicon adjacency).
export function Wordmark({ className, size = "md", variant = "full", tone = "auto" }) {
  const px = MARK_SIZE[size];
  const markSrc = tone === "dark" ? "/images/logo-mark-light.svg" : "/images/logo-mark.svg";

  if (variant === "mark") {
    return (
      <img
        src={markSrc}
        width={px}
        height={px}
        alt="slip/scan"
        className={cn("inline-block shrink-0 select-none", className)}
        draggable={false}
      />
    );
  }

  return (
    <div className={cn("inline-flex items-center gap-2 select-none", className)}>
      <img
        src={markSrc}
        width={px}
        height={px}
        alt=""
        className="shrink-0"
        draggable={false}
        aria-hidden
      />
      <span
        className={cn(
          "wordmark inline-flex items-baseline",
          TEXT_SIZE[size],
          tone === "dark" && "text-ink-0",
        )}
      >
        <span>slip</span>
        <span className="wordmark-slash">/</span>
        <span>scan</span>
      </span>
    </div>
  );
}
