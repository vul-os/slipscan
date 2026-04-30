import { cn } from "@/lib/cn";

export function Skeleton({ className, ...props }) {
  return <div className={cn("skeleton h-4 w-full", className)} {...props} />;
}
