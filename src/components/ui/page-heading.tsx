import type { ReactNode } from "react";

/** The page's one h1. Route changes move focus here (RouteFocus), so it is programmatically focusable. */
export function PageHeading({ children }: { children: ReactNode }) {
  return (
    <h1
      data-page-heading=""
      tabIndex={-1}
      className="text-2xl font-semibold leading-tight tracking-tight text-foreground tablet:text-3xl"
    >
      {children}
    </h1>
  );
}
