import type { ReactNode } from "react";

/** The page's one h1. Route changes move focus here (RouteFocus), so it is programmatically focusable. */
export function PageHeading({ children }: { children: ReactNode }) {
  return (
    <h1
      data-page-heading=""
      tabIndex={-1}
      className="text-[26px] font-semibold tracking-[-0.025em] text-ink-1 tablet:text-[30px]"
    >
      {children}
    </h1>
  );
}
