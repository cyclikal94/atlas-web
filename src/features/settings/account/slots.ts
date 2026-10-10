import type { ReactNode } from "react";

/**
 * The seam WEB-08c appends to: controls that sit beside "Sign out" on the account card, in order ("Switch account" is the
 * first). WEB-08b ships it EMPTY on purpose: the switch journey is WEB-08c's, and a control that led to a missing or fake flow
 * would be worse than none (docs/session.md, decisions D-8b-08 and gap G-20). Each entry is a function so it can use hooks.
 */
export const accountActions: readonly {
  readonly id: string;
  readonly render: () => ReactNode;
}[] = [];
