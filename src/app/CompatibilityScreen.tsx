import { useEffect, useRef } from "react";
import { List } from "../components/ui/list";
import type { CapabilityId, CapabilityIssue } from "./capabilities";

const EXPLANATION: Record<CapabilityId, string> = {
  "secure-context":
    "Atlas needs a secure connection (HTTPS). Ask whoever runs Atlas for you to serve it over HTTPS.",
  "web-locks":
    "This browser does not provide Web Locks, which Atlas uses to keep accounts separate when it is open in more than one tab.",
  indexeddb:
    "Atlas cannot use this browser's local storage (IndexedDB). A private window or a storage setting can cause this.",
  inert:
    "This browser is too old to keep your data hidden when Atlas locks. Please update it.",
};

/**
 * Shown instead of the application when a required capability is missing or broken (Q12). There is no
 * fallback and no way past it, and it shows nothing about any account. Neutral screens live in #neutral-root.
 */
export function CompatibilityScreen({
  issues,
}: {
  issues: readonly CapabilityIssue[];
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className="mx-auto flex max-w-[620px] flex-col gap-4 px-5 py-16">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-[26px] font-semibold tracking-[-0.025em] text-ink-1"
      >
        Atlas can't open in this browser
      </h1>
      <List className="flex flex-col gap-2">
        {issues.map((issue) => (
          <li
            key={issue.id}
            data-capability={issue.id}
            className="list-none text-[14px] leading-[1.6] text-ink-1"
          >
            {EXPLANATION[issue.id]}
          </li>
        ))}
      </List>
      <p className="text-[14px] leading-[1.6] text-ink-2">
        Atlas works in the current or previous version of Chrome, Edge, Firefox
        or Safari (including Chrome on Android and Safari on iPhone and iPad),
        over HTTPS.
      </p>
    </main>
  );
}
