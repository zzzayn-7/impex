import type { HTMLAttributes, ReactNode } from "react";

// The three glass surface levels of the portal (the CSS is in globals.css; every page that wants glass uses THESE, never its own copy):
//   GlassCard   level 1  main cards: noticeable frosted glass (dashboard figures, hero cards)
//   GlassPanel  level 2  tables and form containers: slightly more opaque, lighter blur, for readability
//   InsetPanel  level 3  nested panels: almost opaque, no blur of their own

type Props = HTMLAttributes<HTMLElement> & { children?: ReactNode; className?: string };

export { GlassCard } from "@/components/dashboard/glass";

export function GlassPanel({ className = "", children, ...rest }: Props) {
  return <section {...rest} className={`ix-panel relative ${className}`}>{children}</section>;
}

export function InsetPanel({ className = "", children, ...rest }: Props) {
  return <div {...rest} className={`ix-inset ${className}`}>{children}</div>;
}
