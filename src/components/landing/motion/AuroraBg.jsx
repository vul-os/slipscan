import { cn } from "@/lib/cn";

/**
 * AuroraBg — soft lime aurora wash + static SVG grain.
 *
 * Two layered overlays meant to live behind section content on a dark bg:
 *   1. Aurora layer: 2–3 large, heavily-blurred radial lime blobs that drift
 *      very slowly (18–22s) via translate3d + scale. Suspends under
 *      prefers-reduced-motion. Layout per `variant`.
 *   2. Grain layer: a single inline SVG feTurbulence pattern tiled at 220px.
 *      Static (animating noise turns to TV-static). Very low opacity.
 *
 * Both layers are absolute, inset-0, pointer-events-none. Drop the component
 * as a sibling of your existing section background washes — it sits above
 * the bare background colour but below content (use z-10 on content).
 *
 * @param {Object}  props
 * @param {string} [props.className]
 * @param {"hero"|"demo"|"cta"} [props.variant="hero"]
 */
export default function AuroraBg({ className, variant = "hero" }) {
  // Per-variant blob positions. Each entry becomes one radial-gradient blob.
  //   pos: "x% y%" for radial-gradient origin
  //   size: "w% h%" gradient ellipse extent
  //   alpha: peak lime alpha at centre (0..1)
  //   anim: which keyframe (drift | drift-alt)
  //   scale: tailwind classes for responsive sizing (sm: tighter)
  const BLOBS = {
    hero: [
      { pos: "78% 18%", size: "55% 50%", alpha: 0.18, anim: "drift",     extra: "scale-90 sm:scale-100" },
      { pos: "12% 82%", size: "50% 50%", alpha: 0.12, anim: "drift-alt", extra: "scale-90 sm:scale-100" },
    ],
    demo: [
      { pos: "82% 22%", size: "45% 50%", alpha: 0.16, anim: "drift",     extra: "scale-95 sm:scale-100" },
      { pos: "92% 55%", size: "40% 45%", alpha: 0.10, anim: "drift-alt", extra: "scale-95 sm:scale-100" },
    ],
    cta: [
      { pos: "50% 45%", size: "55% 55%", alpha: 0.16, anim: "drift",     extra: "scale-95 sm:scale-100" },
      { pos: "55% 92%", size: "60% 45%", alpha: 0.12, anim: "drift-alt", extra: "scale-95 sm:scale-100" },
      { pos: "20% 60%", size: "40% 40%", alpha: 0.08, anim: "drift",     extra: "scale-95 sm:scale-100" },
    ],
  };

  const blobs = BLOBS[variant] ?? BLOBS.hero;

  // mix-blend-screen interacts oddly with the Hero photo (washes out skin
  // tones, sometimes goes greenish over the receipts). Keep it off for hero
  // and on for demo/cta where the bg is uniform ink-950.
  const useScreenBlend = variant !== "hero";

  // Inline SVG noise — feTurbulence + desaturate + bumped alpha, tiled.
  // URL-encoded inline so no extra HTTP request.
  const noiseSvg =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'>" +
        "<filter id='n'>" +
          "<feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/>" +
          "<feColorMatrix type='matrix' values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.65 0'/>" +
        "</filter>" +
        "<rect width='100%' height='100%' filter='url(#n)'/>" +
      "</svg>"
    );

  return (
    <div
      className={cn("absolute inset-0 pointer-events-none overflow-hidden", className)}
      aria-hidden
    >
      {/* Aurora layer */}
      <div
        className={cn(
          "absolute inset-0",
          useScreenBlend && "mix-blend-screen",
        )}
        style={{ filter: "blur(80px)" }}
      >
        {blobs.map((b, i) => (
          <div
            key={i}
            className={cn(
              "absolute inset-0",
              b.anim === "drift"
                ? "animate-aurora-drift"
                : "animate-aurora-drift-alt",
              "motion-reduce:animate-none",
              b.extra,
            )}
            style={{
              backgroundImage: `radial-gradient(ellipse ${b.size} at ${b.pos}, rgb(200 255 0 / ${b.alpha}) 0%, transparent 70%)`,
              willChange: "transform",
            }}
          />
        ))}
      </div>

      {/* Static grain layer */}
      <div
        className="absolute inset-0 opacity-[0.05] mix-blend-overlay"
        style={{
          backgroundImage: `url("${noiseSvg}")`,
          backgroundSize: "220px 220px",
          backgroundRepeat: "repeat",
        }}
      />
    </div>
  );
}
