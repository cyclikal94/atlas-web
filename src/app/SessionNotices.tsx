import { useEffect } from "react";
import { useAnnouncer } from "../components/ui/announcer";
import { Button } from "../components/ui/button";
import { useSession, useSessionNotices } from "../session";

/**
 * Facts the person should be told once. Today there is one: a logout or retirement was confirmed applied AFTER the person
 * signed in again to recover, so this browser's saved data for the account was cleared but the new sign-in was left alone
 * (matrix 3.5.4: never signed out automatically; that would be a second, unconfirmed, destructive action). The wording is
 * PROPOSED (design gap G-13). It carries no account data.
 */
export const REMAINED_SIGNED_IN =
  "The sign-out you asked for earlier had already gone through, so this browser's saved copy of your data was cleared. Your new sign-in was left as it is.";

export function SessionNotices() {
  const session = useSession();
  const notices = useSessionNotices();
  const announcer = useAnnouncer();
  const first = notices[0]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per notice, not per announcer identity
  useEffect(() => {
    if (first) announcer.announce(REMAINED_SIGNED_IN);
  }, [first]);
  if (notices.length === 0) return null;
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
    </section>
  );
}
