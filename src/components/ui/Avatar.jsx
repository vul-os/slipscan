import { useState } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

// Initials avatar. Hue is derived from the name so the same person gets
// the same color across the app — small detail that aids recognition.
// Pass `src` to show an image; falls back to pravatar.cc (deterministic per
// name), then to initials if that also fails.
export function Avatar({ name, src, size = "md", className }) {
  // Step 0 = configured src, step 1 = pravatar fallback, step 2 = initials
  const [step, setStep] = useState(0);

  const dim =
    size === "xs" ? "h-5 w-5 text-[9px]"
    : size === "sm" ? "h-7 w-7 text-[10px]"
    : size === "lg" ? "h-10 w-10 text-sm"
    : "h-8 w-8 text-[11px]";

  const pravatarUrl = `https://i.pravatar.cc/300?u=${encodeURIComponent(name || "user")}`;

  const imgSrc =
    step === 0 && src ? src
    : step <= 1    ? pravatarUrl
    : null;

  const showImage = imgSrc !== null;

  if (showImage) {
    return (
      <span
        className={cn("inline-flex items-center justify-center rounded-full overflow-hidden select-none shrink-0", dim, className)}
        aria-hidden="true"
      >
        <img
          src={imgSrc}
          alt={name || ""}
          className="w-full h-full object-cover"
          onError={() => setStep((s) => s + 1)}
        />
      </span>
    );
  }

  const hue = name ? hashHue(name) : 0;
  const bg = name ? `hsl(${hue} 60% 92%)` : "#F4F4F5";
  const fg = name ? `hsl(${hue} 50% 28%)` : "#71717A";
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-full font-medium tracking-tight select-none", dim, className)}
      style={{ background: bg, color: fg }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
