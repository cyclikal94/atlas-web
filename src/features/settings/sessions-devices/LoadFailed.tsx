import { useEffect } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import type { LoadError } from "./useLoad";

export const loadFailedMessage = (what: string, error: LoadError): string =>
  error.reason === "offline"
    ? `You're offline, so we can't load ${what} right now.`
    : `Couldn't load ${what} — please try again.`;

/** An error banner with its own retry and a copyable request ID. Each section has its own (WF-SETTINGS-02, F5). */
export function LoadFailed({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: LoadError;
  onRetry(): void;
}) {
  const announcer = useAnnouncer();
  const message = loadFailedMessage(what, error);
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per error, not per announcer identity
  useEffect(() => announcer.announce(message, "assertive"), [message]);
  return (
    <div
      data-load-error=""
      className="flex flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <p className="text-[13.5px] text-ink-1">{message}</p>
      {error.requestId ? (
        <p className="text-[12px] text-ink-2">Request ID: {error.requestId}</p>
      ) : null}
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}
