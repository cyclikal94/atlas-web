import { useCallback, useEffect, useRef, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { List } from "../../../components/ui/list";
import {
  type CacheRow,
  type FormCopyCursor,
  useCachedResource,
  useDraftWithCommand,
  useFormCopies,
} from "../../../data";
import * as copy from "../copy";
import { type PeopleEnv, usePeopleEnv } from "../env";
import {
  type CheckResult,
  checkRetired,
  discardHold,
  forgetRecord,
  type HeldResult,
  type HeldSettle,
  isSettled,
  lockOf,
  progressOf,
  runHeldChange,
} from "../field/held";
import {
  type HeldChange,
  type HeldCopy,
  heldOf,
  heldPrefixOf,
} from "../field/held-store";
import { type HeldRun, isCurrentMemory, useMemoryRevision } from "../memory";
import { useOutboxSave } from "../parts";
import { FieldValueView } from "./FieldValueView";

/**
 * The audience changes held for this person's fields (D-11a-12), DURABLE in the account's database (`field/held-store.ts`, finding 6),
 * with their state and "Send now" / "Try again" / "Discard".
 *
 *  - LISTED A BOUNDED PAGE AT A TIME (review 2 of 22 October 2026, finding 4): one page of `readFormCopies` after a cursor, with "Show
 *    more held changes" while the read says more may follow (an empty page that says so is never "nothing held") and "Back to the first".
 *    Only the current cursor is kept. A failed read says so; it is never an empty list.
 *  - RUN BY THIS PAGE ONLY WITH ITS AUTHORITY (D1, decided 22 October 2026: "explicit Send now"): a hold made in this page, or one the
 *    person chose "Send now" or "Try again" for here, runs when the page is online and writable, one at a time, by one page of the browser
 *    at a time per field (`exclusive`, held for the whole run and its last write). Any other hold (after a reload, an account switch back,
 *    one held in another page, one whose discard could not be written) waits for "Send now".
 *  - Every outcome is the store's own: a discard is said only when the hold's copy ENDED (a conditional end from the state shown) or was
 *    RETIRED (its policy step may have been made: the attempt is kept as a reconciliation record, review 3 C3c); one that the store
 *    refused or failed stays visible, with its reason, and never runs again by itself. Each run reads its own field directly (finding 5)
 *    and the hold again under the lock (`runHeldChange`).
 *  - LEAVING IS NOT DISCARDING (review 3 of 22 October 2026, finding 1): a row that unmounts (another person, the list, another page of
 *    held changes) only stops its run (`suspended`); nothing is ended, and the hold is listed again, with its authority in this page.
 *  - A reconciliation record ("may already have been made") offers "Check now" (one owner-only read, nothing sent, nothing ended: it says
 *    what the audience IS now, never what the attempt did; review 4 finding 4) and "Discard" (forgets that record only).
 *  - A LEGACY copy (an earlier shape, before heads and tombstones; review 4) is shown and discardable, never sent from here.
 */
export function HeldChanges({ personId }: { personId: string }) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const [after, setAfter] = useState<FormCopyCursor | null>(null);
  const copies = useFormCopies(heldPrefixOf(personId), after);
  if (copies.status === "loading")
    return after === null ? null : (
      <p className="text-[13px] text-ink-2">{copy.HELD_CHECKING}</p>
    );
  if (copies.status === "unavailable")
    return copies.reason === "error" ? (
      <p className="text-[13px] text-ink-2">{copy.HELD_LIST_FAILED}</p>
    ) : null;
  const { copies: rows, next } = copies.value;
  if (rows.length === 0 && next === null && after === null) return null;
  return (
    <div className="flex flex-col gap-2" data-held-page="">
      {rows.length > 0 ? (
        <List className="flex flex-col gap-2" data-held-changes="">
          {rows.map((row) => {
            const held = heldOf(row);
            return held === null || held.change.personId !== personId ? (
              <UnreadableHeld
                key={row.tab_instance_id}
                formContext={row.form_context}
                holdId={row.tab_instance_id}
                digest={row.content_digest}
              />
            ) : held.change.retired ? (
              <RetiredHeld key={held.change.holdId} env={env} held={held} />
            ) : held.change.legacy ? (
              <LegacyHeld key={held.change.holdId} env={env} held={held} />
            ) : held.change.predecessor === "unknown" ? (
              <UnboundHeld key={held.change.holdId} env={env} held={held} />
            ) : (
              <HeldRow key={held.change.holdId} env={env} held={held} />
            );
          })}
        </List>
      ) : next !== null ? (
        <p className="text-[13px] text-ink-2">{copy.HELD_MORE_EMPTY}</p>
      ) : null}
      {next !== null || after !== null ? (
        <div className="flex flex-wrap gap-2">
          {after !== null ? (
            <Button variant="quiet" onClick={() => setAfter(null)}>
              {copy.HELD_FIRST}
            </Button>
          ) : null}
          {next !== null ? (
            <Button variant="quiet" onClick={() => setAfter(next)}>
              {copy.HELD_MORE}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Why an end or a write did not commit, in the row. */
const notCommitted = (kind: "changed" | "refused" | "failed"): string =>
  kind === "changed"
    ? copy.HELD_CHANGED_ELSEWHERE
    : kind === "refused"
      ? copy.REFUSED.closing
      : copy.HELD_DISCARD_FAILED;

/** What ending a hold that was in `change`'s state means for the person. */
function endedMessage(change: HeldChange): string {
  const progress = progressOf(change);
  if (progress.content) return copy.HELD_CONTENT_MAYBE(change.label);
  if (progress.policy === "done") return copy.HELD_POLICY_DONE(change.label);
  if (progress.policy === "maybe")
    return copy.HELD_POLICY_UNCERTAIN(change.label);
  return copy.HELD_STOPPED(change.label);
}

function UnreadableHeld({
  formContext,
  holdId,
  digest,
}: {
  formContext: string;
  holdId: string;
  digest: string;
}) {
  const env = usePeopleEnv();
  const [, personId = "", fieldId = ""] = formContext.split(":");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const discard = async () => {
    setBusy(true);
    setNote(null);
    const end = await env.held.end(
      { personId, fieldId, holdId },
      digest,
      "discarded",
    );
    setBusy(false);
    if (!isSettled(end))
      setNote(notCommitted(end.kind as "changed" | "refused" | "failed"));
  };
  return (
    <li
      data-held-change={holdId}
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">{copy.HELD_UNREADABLE}</p>
      {note !== null ? (
        <p className="text-[12.5px] text-conflict-text">{note}</p>
      ) : null}
      {busy ? (
        <Button variant="quiet" disabled reason={copy.SAVING}>
          {copy.DISCARD}
        </Button>
      ) : (
        <Button variant="quiet" onClick={() => void discard()}>
          {copy.DISCARD}
        </Button>
      )}
    </li>
  );
}

function HeldRow({ env, held }: { env: PeopleEnv; held: HeldCopy }) {
  const memory = env.memory;
  const change = held.change;
  const holdId = change.holdId;
  const save = useOutboxSave();
  const announcer = useAnnouncer();
  const field = useCachedResource(change.fieldId);
  const current: CacheRow | null =
    field.status === "ready" &&
    field.value.merged?.kind === "field" &&
    field.value.merged.parent_id === change.personId
      ? field.value.merged
      : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  // The save the content was typed over, read live (review 12): an early answer, so a hold known to be stale changes no audience.
  const predecessor =
    typeof change.predecessor === "object" ? change.predecessor : null;
  const predecessorBody = useDraftWithCommand(predecessor?.localId ?? null);
  const follows = (): "stands" | "changed" | "unknown" =>
    predecessor === null || predecessorBody.status !== "ready"
      ? "unknown"
      : predecessorBody.value !== null &&
          predecessorBody.value.local_id === predecessor.localId &&
          predecessorBody.value.command_digest === predecessor.digest
        ? "stands"
        : "changed";
  const followsRef = useRef(follows);
  followsRef.current = follows;
  // The state the row shows now: what a run or a discard starts from (the live list may move on meanwhile).
  const heldRef = useRef(held);
  heldRef.current = held;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A run that came back `waiting` (not sent) runs again only when the env changes: never in a loop.
  const [pausedFor, setPausedFor] = useState<PeopleEnv | null>(null);
  // A run that found the field's lock taken (another page's run, this page's replacement of an earlier hold) looks again once it is let go.
  const [lockBusy, setLockBusy] = useState(false);
  // This page's own outcome that the store does not hold (a failure it could not write, a discard that did not commit).
  const [note, setNote] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // A run found the stored hold moved on from the state shown: not run again until the list shows another state.
  const [stale, setStale] = useState<string | null>(null);
  const run = memory.heldRuns.get(holdId);
  // Another row's run (one at a time in the page): when it ends, a row that waited for it looks again (review 4: it never did).
  const running = memory.heldRuns.size;
  const authorised = memory.heldAuthority.has(holdId);
  const failure = change.status.kind === "failed" ? change.status.reason : null;
  const fieldSettled =
    field.status !== "loading" &&
    (predecessor === null || predecessorBody.status !== "loading");

  const finish = useCallback(
    (result: HeldResult | null, mine: HeldRun, shown: HeldCopy) => {
      if (!isCurrentMemory(memory)) return;
      let message: string | null = null;
      if (result === null) {
        setLockBusy(true);
        void env.released(lockOf(env, change.fieldId)).then(() => {
          if (mounted.current) setLockBusy(false);
        });
      } else if (result.kind === "waiting") setPausedFor(env);
      else if (result.kind === "stale") setStale(shown.digest);
      // Stopped because the row left the page (or the identity changed): nothing ended, nothing to say; it is listed again as it is.
      // (Its end is still published by the run's finalisation, so a row that waited for it looks again: review 5, finding 1.)
      else if (result.kind === "suspended") return;
      else if (result.kind === "superseded") {
        if (result.ended) message = copy.HELD_REPLACED(change.label);
        else setNote(copy.HELD_DISCARD_FAILED);
      } else if (result.kind === "failed") {
        if (!result.kept) setNote(copy.HELD_FAILED[result.reason] ?? null);
      } else if (result.kind === "done") {
        message = copy.SAVED_NOT_SENT;
        if (result.ended) memory.heldEnded.add(holdId);
        else {
          memory.heldAuthority.delete(holdId);
          setNote(copy.HELD_NOT_ENDED);
        }
      } else if (result.kind === "cancelled") {
        if (result.ended) {
          // A retired hold is listed again as its reconciliation record (its attempt is kept there, durably: never copied into the page's
          // memory, where it could replace another attempt of the field, review 4 finding 3).
          if (!result.retired) memory.heldEnded.add(holdId);
          if (mine.cancelled)
            message =
              result.policy === "done"
                ? copy.HELD_POLICY_DONE(change.label)
                : result.policy === "maybe"
                  ? copy.HELD_POLICY_UNCERTAIN(change.label)
                  : copy.HELD_STOPPED(change.label);
        } else setNote(copy.HELD_DISCARD_FAILED);
      }
      if (message !== null) announcer.announce(message, "polite");
    },
    [env, memory, holdId, change.fieldId, change.label, announcer],
  );

  const start = useCallback(() => {
    if (memory.heldRuns.size > 0 || memory.heldEnded.has(holdId)) return;
    const shown = heldRef.current;
    const mine: HeldRun = { holdId, cancelled: false, policyDone: false };
    memory.heldRuns.set(holdId, mine);
    memory.touch();
    void (async () => {
      let result: HeldResult | null;
      try {
        // One run of the FIELD's holds at a time in the whole browser, held until its last durable write.
        result = await env.exclusive(lockOf(env, shown.change.fieldId), () =>
          runHeldChange(env, shown, mine, {
            current: () => currentRef.current,
            mounted: () => mounted.current,
            enqueue: save,
            follows: () => followsRef.current(),
          }),
        );
      } catch {
        result = { kind: "failed", reason: "not_saved", kept: false };
      } finally {
        if (memory.heldRuns.get(holdId) === mine)
          memory.heldRuns.delete(holdId);
      }
      // Whatever the outcome (a suspended run returns early from `finish`), its end is published to this identity's rows once the outcome is
      // applied: a row that waited for this run looks again (review 5, finding 1). Never to another identity's memory; it grants nothing.
      try {
        finish(result, mine, shown);
      } finally {
        if (isCurrentMemory(memory)) memory.touch();
      }
    })();
  }, [env, memory, holdId, save, finish]);

  const ended = memory.heldEnded.has(holdId);
  // `held.digest`: a new stored state of the hold is a reason to look again.
  useEffect(() => {
    if (
      !authorised ||
      ended ||
      failure !== null ||
      note !== null ||
      discarding ||
      lockBusy ||
      stale === held.digest ||
      run !== undefined ||
      running > 0 ||
      !fieldSettled ||
      !env.online ||
      !env.writable ||
      pausedFor === env
    )
      return;
    start();
  }, [
    authorised,
    ended,
    failure,
    note,
    discarding,
    lockBusy,
    stale,
    run,
    running,
    fieldSettled,
    env,
    pausedFor,
    start,
    held.digest,
  ]);

  /** "Send now" (a recovered hold) and "Try again" (a failure): this page may run it; a stored failure is first written back as waiting. */
  const resume = async () => {
    setNote(null);
    if (failure !== null) {
      const shown = heldRef.current;
      const written = await env.held.update(shown, {
        ...shown.change,
        status: { kind: "waiting" },
      });
      if (written.kind !== "saved") {
        setNote(
          written.kind === "failed"
            ? (copy.HELD_FAILED.not_saved as string)
            : notCommitted(written.kind),
        );
        return;
      }
    }
    memory.heldAuthority.add(holdId);
    setPausedFor(null);
    memory.touch();
  };

  const discard = async () => {
    // A hold the person discarded never runs by itself again in this page, whatever the store answers.
    memory.heldAuthority.delete(holdId);
    if (run !== undefined) {
      // Running: the run stops at its next admission boundary and ends the hold itself (see `runHeldChange`).
      run.cancelled = true;
      memory.touch();
      return;
    }
    setNote(null);
    setDiscarding(true);
    const shown = heldRef.current;
    let end: HeldSettle;
    try {
      end = await discardHold(env.held, shown);
    } catch {
      end = { kind: "failed" };
    }
    setDiscarding(false);
    if (!isCurrentMemory(memory)) return;
    if (isSettled(end)) {
      // A retired hold (its policy step may have been made) is listed again as its reconciliation record, which keeps its attempt.
      if (end.kind !== "retired") memory.heldEnded.add(holdId);
      if (end.kind === "ended" || end.kind === "retired")
        announcer.announce(endedMessage(shown.change), "polite");
      memory.touch();
      return;
    }
    setNote(notCommitted(end.kind as "changed" | "refused" | "failed"));
    memory.touch();
  };

  const stopping = run?.cancelled === true;
  if (ended && run === undefined) return null;
  const retryable = run === undefined && (failure !== null || note !== null);
  const sendable =
    run === undefined && !retryable && !authorised && !discarding;
  const offlineReason = !env.writable
    ? copy.READ_ONLY_COMPAT
    : !env.online
      ? copy.NEEDS_CONNECTION
      : null;
  return (
    <li
      data-held-change={holdId}
      data-held-field={change.fieldId}
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">
        {stopping
          ? copy.HELD_STOPPING(change.label)
          : discarding
            ? copy.HELD_DISCARDING(change.label)
            : run !== undefined
              ? copy.HELD_RUNNING(change.label)
              : authorised
                ? copy.HELD_WAITING(change.label)
                : copy.HELD_RECOVERED(change.label)}
      </p>
      {run === undefined && failure !== null ? (
        <p className="text-[12.5px] text-conflict-text">
          {copy.HELD_FAILED[failure]}
        </p>
      ) : null}
      {note !== null ? (
        <p className="text-[12.5px] text-conflict-text">{note}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {retryable && !discarding ? (
          <Button onClick={() => void resume()}>{copy.TRY_AGAIN}</Button>
        ) : sendable ? (
          offlineReason === null ? (
            <Button onClick={() => void resume()}>{copy.SEND_NOW}</Button>
          ) : (
            <Button disabled reason={offlineReason}>
              {copy.SEND_NOW}
            </Button>
          )
        ) : null}
        {stopping || discarding ? (
          <Button variant="quiet" disabled reason={copy.SAVING}>
            {copy.DISCARD}
          </Button>
        ) : (
          <Button variant="quiet" onClick={() => void discard()}>
            {copy.DISCARD}
          </Button>
        )}
      </div>
    </li>
  );
}

/** What a check observed, for the person (never what the attempt did). */
const observedMessage = (
  found: Extract<CheckResult, { kind: "observed" }>,
  name: string,
): string =>
  found.unchanged
    ? copy.HELD_CHECKED_UNCHANGED(name)
    : found.matches
      ? copy.HELD_CHECKED_MATCHES(name)
      : copy.HELD_CHECKED_OTHER(name);

/**
 * A RETIRED hold (review 3, C3c): its content was discarded or replaced while its policy step may have been made, so its attempt is kept
 * on this device. Never run. "Check now" reads the field's policy once (nothing is sent, nothing ended) and says what the audience IS
 * now; whether the attempt was made stays unknown, so the record stays (review 4, finding 4). "Discard" forgets THIS record (the person's
 * explicit choice: a later change of the audience is still guarded by its policy version).
 */
function RetiredHeld({ env, held }: { env: PeopleEnv; held: HeldCopy }) {
  const memory = env.memory;
  const change = held.change;
  const announcer = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [observed, setObserved] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setNote(null);
    let found: CheckResult;
    try {
      found = await checkRetired(env, held);
    } catch {
      found = { kind: "failed" };
    }
    setBusy(false);
    if (!isCurrentMemory(memory)) return;
    if (found.kind === "observed") {
      const message = observedMessage(found, change.label);
      setObserved(message);
      announcer.announce(message, "polite");
    } else setNote(copy.HELD_CHECK_FAILED);
  };
  const discard = async () => {
    setBusy(true);
    setNote(null);
    let end: HeldSettle;
    try {
      end = await forgetRecord(env.held, held);
    } catch {
      end = { kind: "failed" };
    }
    setBusy(false);
    if (!isCurrentMemory(memory)) return;
    if (isSettled(end)) {
      memory.heldEnded.add(change.holdId);
      memory.touch();
    } else setNote(notCommitted(end.kind as "changed" | "refused" | "failed"));
  };
  if (memory.heldEnded.has(change.holdId)) return null;
  return (
    <li
      data-held-change={change.holdId}
      data-held-field={change.fieldId}
      data-held-retired=""
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">
        {copy.HELD_UNRESOLVED(change.label)}
      </p>
      {observed !== null ? (
        <p className="text-[13px] text-ink-2" data-held-observed="">
          {observed}
        </p>
      ) : null}
      {note !== null ? (
        <p className="text-[12.5px] text-conflict-text">{note}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {busy ? (
          <Button disabled reason={copy.SAVING}>
            {copy.CHECK_NOW}
          </Button>
        ) : env.online ? (
          <Button onClick={() => void check()}>{copy.CHECK_NOW}</Button>
        ) : (
          <Button disabled reason={copy.NEEDS_CONNECTION}>
            {copy.CHECK_NOW}
          </Button>
        )}
        {busy ? (
          <Button variant="quiet" disabled reason={copy.SAVING}>
            {copy.DISCARD}
          </Button>
        ) : (
          <Button variant="quiet" onClick={() => void discard()}>
            {copy.DISCARD}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * A hold whose content was typed over a save it never recorded (a v 4 copy; review 12, R12.1): whether that save still has the body the
 * person saw cannot be known, so it is never sent from here, and "Send now" and "Try again" are not offered. Its value and the state of
 * its audience step are shown so nothing is lost; the person edits the field to review it and saves again (a new hold replaces this one)
 * or discards it (`delivery/handoffs/web11a-v4-held-review-before-send-20261024.md`).
 */
function UnboundHeld({ env, held }: { env: PeopleEnv; held: HeldCopy }) {
  const memory = env.memory;
  const change = held.change;
  const announcer = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const policy = progressOf(change).policy;
  const discard = async () => {
    memory.heldAuthority.delete(change.holdId);
    setBusy(true);
    setNote(null);
    let end: HeldSettle;
    try {
      end = await discardHold(env.held, held);
    } catch {
      end = { kind: "failed" };
    }
    setBusy(false);
    if (!isCurrentMemory(memory)) return;
    if (isSettled(end)) {
      if (end.kind !== "retired") memory.heldEnded.add(change.holdId);
      announcer.announce(endedMessage(change), "polite");
      memory.touch();
    } else setNote(notCommitted(end.kind as "changed" | "refused" | "failed"));
  };
  if (memory.heldEnded.has(change.holdId)) return null;
  return (
    <li
      data-held-change={change.holdId}
      data-held-field={change.fieldId}
      data-held-unbound=""
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">
        {copy.HELD_UNBOUND(change.label)}
      </p>
      <div className="text-[13px] text-ink-2" data-held-value="">
        <FieldValueView raw={change.value} />
      </div>
      {policy === "maybe" ? (
        <p className="text-[12.5px] text-ink-2">
          {copy.HELD_UNBOUND_POLICY_MAYBE(change.label)}
        </p>
      ) : policy === "done" ? (
        <p className="text-[12.5px] text-ink-2">
          {copy.HELD_UNBOUND_POLICY_DONE(change.label)}
        </p>
      ) : null}
      {note !== null ? (
        <p className="text-[12.5px] text-conflict-text">{note}</p>
      ) : null}
      {busy ? (
        <Button variant="quiet" disabled reason={copy.SAVING}>
          {copy.DISCARD}
        </Button>
      ) : (
        <Button variant="quiet" onClick={() => void discard()}>
          {copy.DISCARD}
        </Button>
      )}
    </li>
  );
}

/**
 * A LEGACY hold (an earlier shape, written before heads and tombstones; review 4): whether it was already queued and discarded in Sync, or
 * replaced by a hold that has since ended, cannot be known, so it is never sent from here. It is shown so its text is not lost, and
 * "Discard" ends it (or keeps its unresolved attempt as a reconciliation record).
 */
function LegacyHeld({ env, held }: { env: PeopleEnv; held: HeldCopy }) {
  const memory = env.memory;
  const change = held.change;
  const announcer = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const discard = async () => {
    setBusy(true);
    setNote(null);
    let end: HeldSettle;
    try {
      end = await discardHold(env.held, held);
    } catch {
      end = { kind: "failed" };
    }
    setBusy(false);
    if (!isCurrentMemory(memory)) return;
    if (isSettled(end)) {
      if (end.kind !== "retired") memory.heldEnded.add(change.holdId);
      announcer.announce(endedMessage(change), "polite");
      memory.touch();
    } else setNote(notCommitted(end.kind as "changed" | "refused" | "failed"));
  };
  if (memory.heldEnded.has(change.holdId)) return null;
  return (
    <li
      data-held-change={change.holdId}
      data-held-field={change.fieldId}
      data-held-legacy=""
      className="flex list-none flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3"
    >
      <p className="text-[13px] text-ink-1">{copy.HELD_LEGACY(change.label)}</p>
      {note !== null ? (
        <p className="text-[12.5px] text-conflict-text">{note}</p>
      ) : null}
      {busy ? (
        <Button variant="quiet" disabled reason={copy.SAVING}>
          {copy.DISCARD}
        </Button>
      ) : (
        <Button variant="quiet" onClick={() => void discard()}>
          {copy.DISCARD}
        </Button>
      )}
    </li>
  );
}
