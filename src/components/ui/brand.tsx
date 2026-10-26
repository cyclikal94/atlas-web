/**
 * The Atlas brand mark (a primary tile with an orbit ring) and the lockup with the wordmark. Decorative: the mark is hidden
 * from assistive technology and the wordmark is plain text, so a caller that needs an accessible name supplies its own. The
 * gate screens draw the same mark statically (`.neutral-gate__mark` in base.css), so a cold load and the shell match.
 */
export function AtlasMark({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={size === "lg" ? "atlas-mark atlas-mark--lg" : "atlas-mark"}
    />
  );
}

/** The mark beside the wordmark, as the rail and the mobile header show it. */
export function AtlasLockup({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="inline-flex flex-none items-center gap-2.5 whitespace-nowrap">
      <AtlasMark />
      {collapsed ? (
        <span className="sr-only">Atlas</span>
      ) : (
        <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
          Atlas
        </span>
      )}
    </span>
  );
}
