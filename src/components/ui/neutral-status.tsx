import type { ReactNode } from "react";

/**
 * The live region of the PUBLIC surfaces (sign-in and join, in #neutral-root). The neutral root has no announcer, and a
 * refusal ("That username or password isn't right.") has to be announced once, when it appears.
 *
 * This file is on the R6 live-region allowlist (WEB-08b decision D-8b-11, a reviewed widening). The risk R6 guards is a
 * live region announcing PROTECTED text while the gate is closed; the public surfaces show nothing about any account, never
 * import the gate and never use the portal dialog, so no protected text can reach this component. Callers pass one of the
 * messages of `src/features/authentication/outcome-copy.ts`, a closed catalogue of fixed strings (plus a request ID).
 *
 * An alert is rendered only while there is something to say: a role="alert" element is announced when it is INSERTED.
 */
export function NeutralStatus({
  kind,
  id,
  children,
}: {
  kind: "status" | "alert";
  id?: string;
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      role={kind}
      data-neutral-status={kind}
      className="text-[13px] leading-[1.6] text-ink-1"
    >
      {children}
    </p>
  );
}
