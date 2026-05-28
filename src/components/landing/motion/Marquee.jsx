import { useState } from "react";
import { cn } from "@/lib/cn";

export default function Marquee({
  speed = "40s",
  pauseOnHover = true,
  direction = "left",
  className,
  children,
}) {
  const [paused, setPaused] = useState(false);

  const handleEnter = () => {
    if (pauseOnHover) setPaused(true);
  };
  const handleLeave = () => {
    if (pauseOnHover) setPaused(false);
  };

  return (
    <div
      className={cn("relative overflow-hidden", className)}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div
        data-paused={paused ? "true" : undefined}
        className={cn(
          "flex w-max items-center animate-marquee",
          "data-[paused=true]:[animation-play-state:paused]",
        )}
        style={{
          "--marquee-speed": speed,
          animationDirection: direction === "right" ? "reverse" : "normal",
        }}
      >
        <div className="flex shrink-0 items-center">{children}</div>
        <div className="flex shrink-0 items-center" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}
