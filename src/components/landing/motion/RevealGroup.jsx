import { Children, createElement, isValidElement } from "react";
import Reveal from "./Reveal";
import { cn } from "@/lib/cn";

export default function RevealGroup({
  as = "div",
  stagger = 80,
  className,
  children,
  ...rest
}) {
  const wrapped = Children.map(children, (child, i) => {
    if (!isValidElement(child)) return child;
    return (
      <Reveal delay={i * stagger} key={child.key ?? i}>
        {child}
      </Reveal>
    );
  });

  return createElement(as, { className: cn(className), ...rest }, wrapped);
}
