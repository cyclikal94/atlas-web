import { useEffect, useRef, useSyncExternalStore } from "react";
import { type Announcement, useAnnouncer } from "../components/ui/announcer";
import { Button } from "../components/ui/button";
import { authFeedback } from "../features/authentication/feedback";
import { MessageText } from "../features/authentication/MessageText";
import {
  ENDED_IN_TREE,
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
  /**
   * Every notice OBSERVED in this presentation (by id, never by text or list position), with what it announced if it
   * announced anything (WEB-10a revision 8, review 8 R20). One reconciliation of the whole lists: a removed notice retracts its own
   * announcement (Kieran's decision of 15 October 2026: a later announcement is never erased), and only a notice not seen before
   * is announced: one per source, the first new session notice and the latest new sign-in fact, as before. A removal alone
   * therefore announces nothing, so dismissing one notice can never replay a survivor over a later message (`Progress saved`)
   * or cancel that message's frame, whether the survivor had announced or was observed in the same render as another arrival.
   * Removed ids are forgotten, so the record is bounded by what is shown.
   */
  const observed = useRef(new Map<string | number, Announcement | null>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile per change of the lists, not per announcer identity
  useEffect(() => {
    const seen = observed.current;
    // A session notice's id is a string and a sign-in fact's a number, so the two never meet in one map.
    const shown = [...notices, ...feedback].map((item) => item.id);
    for (const [id, announcement] of seen)
      if (!shown.includes(id)) {
        seen.delete(id);
        announcement?.retract();
      }
    const notice = notices.find((item) => !seen.has(item.id));
    const fact = feedback.filter((item) => !seen.has(item.id)).pop();
    for (const id of shown) if (!seen.has(id)) seen.set(id, null);
    if (notice) seen.set(notice.id, announcer.announce(REMAINED_SIGNED_IN));
    if (fact)
      seen.set(
        fact.id,
        announcer.announce(
          fact.kind === "superseded"
            ? SUPERSEDED_BANNER.message
            : fact.kind === "lock_wait"
              ? LOCK_WAIT_BANNER.heading
              : fact.kind === "ended"
                ? ENDED_IN_TREE.heading
                : textOf(fact.message),
        ),
      );
  }, [notices, feedback]);
  /**
   * The presentation ends with this component (and the provider it lives in, which cancels pending frames): nothing observed is kept,
   * so a protected tree that mounts again presents the surviving page-memory notices afresh, and StrictMode's rehearsal of an unmount
   * announces them again rather than losing them.
   */
  useEffect(() => () => observed.current.clear(), []);
  if (notices.length === 0 && feedback.length === 0) return null;
  return (
    <section
      aria-label="Notices"
      className="atlas-stagger fixed inset-x-4 bottom-20 z-30 flex flex-col gap-2 tablet:inset-x-auto tablet:bottom-5 tablet:right-5 tablet:w-[420px]"
    >
      {notices.map((notice) => (
        <div
          key={notice.id}
          data-notice={notice.kind}
          className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 text-sm leading-relaxed text-card-foreground shadow-lg"
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
          className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 text-sm leading-relaxed text-card-foreground shadow-lg"
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
            ) : item.kind === "ended" ? (
              <>
                <strong className="font-medium">
                  {ENDED_IN_TREE.heading}.
                </strong>{" "}
                {ENDED_IN_TREE.message}
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
