import { useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import type { Result } from "../../../session";
import { MESSAGE_TEXT } from "../../authentication/outcome-copy";
import { isOnlineNow, useOnline } from "../../authentication/use-online";
import { useInteractions } from "../sessions-devices/ownership";

/** [P], review R7: checking asks the server, so it needs a connection like the change it follows. */
export const CHECK_OFFLINE_REASON = "Checking needs a connection.";

/**
 * "We couldn't confirm that." ([D] SETTINGS-03, "If it doesn't come back"): the response to a password change or an unlink
 * was lost, or was a gateway or server error that cannot show the change was not made (`leavesOutcomeUnknown`, review R6), so
 * what happened is NOT known and Atlas does not retry it.
 *
 * "Check now" asks the server who this session still is, and that can only ever END the uncertainty in one direction. A session
 * that has ended hands the screen to the neutral state, which is the honest answer (success revokes every session). A session that
 * STILL WORKS proves nothing about the earlier request: a gateway can be holding it, or the backend can still be executing it,
 * and it can commit after the read. So a successful read leaves the outcome unconfirmed and says exactly that (review R3); it
 * never states "nothing changed" and never sends the change again. While the browser reports no connection the check is disabled
 * with its reason (a hint: a check that does start is judged by its own answer).
 *
 * WEB-08d (design assessment A4, review R4): a check belongs to the screen that asked. If the dialog is dismissed, the screen left or
 * the identity moves on before its answer, the session still observes the read, but nothing is said or shown for it.
 */
export function Unconfirmed({ check }: { check(): Promise<Result<unknown>> }) {
  const announcer = useAnnouncer();
  const online = useOnline();
  const [state, setState] = useState<"idle" | "checking" | "still" | "unknown">(
    "idle",
  );
  const interactions = useInteractions();
  const checking = useRef(false);
  const run = async () => {
    // Synchronous: a second press before "Checking…" renders asks nothing more.
    if (checking.current || !online || !isOnlineNow()) return;
    checking.current = true;
    const interaction = interactions.begin();
    setState("checking");
    let result: Result<unknown> | null = null;
    try {
      result = await check();
    } catch {
      result = null;
    }
    const owned = interaction.current();
    interaction.end();
    checking.current = false;
    if (!owned) return setState("idle");
    if (result?.ok) {
      setState("still");
      announcer.announce(MESSAGE_TEXT.still_unconfirmed);
    } else if (
      result &&
      !result.ok &&
      (result.error === "auth_state" || result.error === "closed")
    ) {
      // The session ended: the neutral state is already on screen (or about to be).
      setState("idle");
    } else setState("unknown");
  };
  return (
    <div
      data-unconfirmed=""
      className="flex flex-col items-start gap-2 rounded-row border border-hairline-strong bg-raised p-3.5"
    >
      <p className="text-[13.5px] leading-[1.6] text-ink-1">
        {MESSAGE_TEXT.unconfirmed}
      </p>
      {state === "still" ? (
        <p data-still-unconfirmed="" className="text-[13px] text-ink-1">
          {MESSAGE_TEXT.still_unconfirmed}
        </p>
      ) : state === "unknown" ? (
        <p className="text-[13px] text-ink-1">
          We couldn't check either. {MESSAGE_TEXT.unreachable}
        </p>
      ) : null}
      {state === "checking" ? (
        <Button disabled reason="Checking…">
          Check now
        </Button>
      ) : !online ? (
        <Button disabled reason={CHECK_OFFLINE_REASON}>
          Check now
        </Button>
      ) : (
        <Button onClick={() => void run()}>Check now</Button>
      )}
    </div>
  );
}
