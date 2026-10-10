import { useEffect, useSyncExternalStore } from "react";
import { useAnnouncer } from "../components/ui/announcer";
import { Button } from "../components/ui/button";
import { authFeedback } from "../features/authentication/feedback";
import { MessageText } from "../features/authentication/MessageText";
import {
  LOCK_WAIT_BANNER,
  SUPERSEDED_BANNER,
  textOf,
} from "../features/authentication/outcome-copy";
import { useSession, useSessionNotices } from "../session";

/**
 * Facts the person should be told once. The session's own (durable-record) notice is one: a logout or retirement was confirmed applied AFTER the person
 * signed in again to recover, so this browser's saved data for the account was cleared but the new sign-in was left alone
 * (matrix 3.5.4: never signed out automatically; that would be a second, unconfirmed, destructive action). The wording is
 * PROPOSED (design gap G-13). It carries no account data.
 *
 * The others are facts about a sign-in that finished while an account displays (WEB-08b, `authFeedback`): "that sign-in was
 * replaced by a newer one" (matrix T1, T2: the stale response was discarded and nothing changed), "single sign-on is now linked".
 * They carry a closed message id, never account data.
 */
export const REMAINED_SIGNED_IN =
  "The sign-out you asked for earlier had already gone through, so this browser's saved copy of your data was cleared. Your new sign-in was left as it is.";

export function SessionNotices() {
  const session = useSession();
  const notices = useSessionNotices();
  const announcer = useAnnouncer();
  const feedback = useSyncExternalStore(
    authFeedback.subscribe,
    authFeedback.get,
    authFeedback.get,
  );
  const first = notices[0]?.id;
  const latest = feedback[feedback.length - 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per notice, not per announcer identity
  useEffect(() => {
    if (first) announcer.announce(REMAINED_SIGNED_IN);
  }, [first]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per fact, not per announcer identity
  useEffect(() => {
    if (!latest) return;
    announcer.announce(
      latest.kind === "superseded"
        ? SUPERSEDED_BANNER.message
        : latest.kind === "lock_wait"
          ? LOCK_WAIT_BANNER.heading
          : textOf(latest.message),
    );
  }, [latest?.id]);
  if (notices.length === 0 && feedback.length === 0) return null;
  return (
    <section
      aria-label="Notices"
      className="fixed inset-x-4 bottom-20 z-30 flex flex-col gap-2 tablet:inset-x-auto tablet:bottom-4 tablet:right-4 tablet:w-[420px]"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          data-notice={notice.kind}
          className="flex flex-col gap-2 rounded-row border border-hairline-strong bg-raised p-3.5 text-[13.5px] leading-[1.6] text-ink-1"
        >
          <p>{REMAINED_SIGNED_IN}</p>
          <div>
            <Button onClick={() => session.dismissNotice(notice.id)}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}
      {feedback.map((item) => (
        <div
          key={`feedback-${item.id}`}
          data-notice={`feedback-${item.kind}`}
          className="flex flex-col gap-2 rounded-row border border-hairline-strong bg-raised p-3.5 text-[13.5px] leading-[1.6] text-ink-1"
        >
          <p>
            {item.kind === "superseded" ? (
              <>
                <strong className="font-medium">
                  {SUPERSEDED_BANNER.heading}.
                </strong>{" "}
                {SUPERSEDED_BANNER.message}
              </>
            ) : item.kind === "lock_wait" ? (
              <>
                <strong className="font-medium">
                  {LOCK_WAIT_BANNER.heading}.
                </strong>{" "}
                {LOCK_WAIT_BANNER.message}
              </>
            ) : (
              <MessageText message={item.message} />
            )}
          </p>
          <div>
            <Button onClick={() => authFeedback.dismiss(item.id)}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
