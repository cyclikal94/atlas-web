import { useEffect, useRef } from "react";
import { List } from "../components/ui/list";
import type { ApiCompatibility } from "../session";
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
 * The API variant (decision D-08): the server's `api_version` is outside the range this client supports, or absent. The
 * wording is PROPOSED, not accepted (design gap G-6): the accepted wireframes have no such screen.
 */
export const API_HEADING = "Atlas can't work with this server yet";
export const API_EXPLANATION = {
  unsupported:
    "This copy of Atlas doesn't work with the version of the server it is talking to. Ask whoever runs Atlas for you to update one of them.",
  missing:
    "This server didn't say which version it is, so Atlas can't be sure it is safe to use. Ask whoever runs Atlas for you to check it.",
} as const;

/** True when the API check, not a browser capability, is the reason to refuse. */
export const isApiRefusal = (
  api: ApiCompatibility | undefined,
): api is Extract<ApiCompatibility, { status: "unsupported" | "missing" }> =>
  api?.status === "unsupported" || api?.status === "missing";

/**
 * Shown instead of the application when a required capability is missing or broken (Q12). There is no
 * fallback and no way past it, and it shows nothing about any account. Neutral screens live in #neutral-root.
 */
export function CompatibilityScreen({
  issues,
  api,
}: {
  issues: readonly CapabilityIssue[];
  api?: ApiCompatibility;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  if (issues.length === 0 && isApiRefusal(api)) {
    return (
      <main
        data-compatibility="api"
        className="mx-auto flex max-w-[620px] flex-col gap-4 px-5 py-16"
      >
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-[26px] font-semibold tracking-[-0.025em] text-ink-1"
        >
          {API_HEADING}
        </h1>
        <p className="text-[14px] leading-[1.6] text-ink-1">
          {API_EXPLANATION[api.status]}
        </p>
      </main>
    );
  }
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
