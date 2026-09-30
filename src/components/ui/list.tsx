import type { ReactNode } from "react";

/**
 * A list with no bullets. Safari and VoiceOver drop list semantics from a list whose list-style is none, so the
 * role is stated explicitly, here once. Use <li className="list-none"> for the items.
 */
export function List({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics when list-style is none, so the role restores them
    <ul role="list" className={`m-0 p-0 ${className}`}>
      {children}
    </ul>
  );
}
