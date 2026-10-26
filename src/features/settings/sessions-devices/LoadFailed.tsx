import { OctagonAlert } from "lucide-react";
import { useEffect } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
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
  useEffect(() => {
    announcer.announce(message, "assertive");
  }, [message]);
  return (
    <Alert data-load-error="" variant="destructive" className="py-2.5">
      <OctagonAlert aria-hidden="true" />
      <p className="col-start-2 text-sm font-medium leading-snug">{message}</p>
      <AlertDescription>
        {error.requestId ? <p>Request ID: {error.requestId}</p> : null}
        <Button onClick={onRetry}>Try again</Button>
      </AlertDescription>
    </Alert>
  );
}
