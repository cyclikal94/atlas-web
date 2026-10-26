import { useEffect, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type CacheRow,
  type CurrentRead,
  type DraftRow,
  useDataActions,
  useDataEnv,
} from "../../data";
import {
  DETAIL_COPY,
  DETAIL_CURRENTLY_SAVED,
  DETAIL_CURRENTLY_SAVED_ON,
  DETAIL_DISCARD_ATTEMPT,
  DETAIL_DISCARD_MINE,
  DETAIL_INDETERMINATE,
  DETAIL_ONLINE_ONLY,
  DETAIL_OPERATION_BODY,
  DETAIL_OPERATION_KIND,
  DETAIL_OPERATION_LIMIT,
  DETAIL_OPERATION_TITLE,
  DETAIL_PROCEED_WITHOUT,
  DETAIL_QUEUED_SINCE,
  DETAIL_READ_FAILED,
  DETAIL_READ_LOADING,
  DETAIL_REF,
  DETAIL_RESEND,
  DETAIL_RETAINED,
  DETAIL_SAVE_NEW,
  DETAIL_SAVE_NEW_FAILED,
  DETAIL_VERSION,
  DETAIL_VERSION_BODY,
  DETAIL_VERSION_KIND,
  DETAIL_VERSION_TITLE,
  DISCARD_CONFIRM,
  DISCARD_CONFIRM_NO,
  DISCARD_CONFIRM_YES,
  DISCARD_FAILED,
  DISCARDED,
} from "./copy";
import { formatSavedAt } from "./rows";

/**
 * WF-QUEUE-02, the GENERIC item-detail dialog (`gaps/queue-02-desktop.html`; owner WEB-09b in `design-gallery.md`). Opened only from
 * a failed row of WF-QUEUE-01 (its one drawn state is the error detail). It reuses the dialog shell and states what the store holds:
 *
 *  - a VERSION CONFLICT: the resource as the SERVER holds it now beside the retained, unsent change, with "Discard mine" and, ONLY when
 *    the command's slice registered `rebuild`, "Resend as a new operation";
 *  - an OPERATION CONFLICT (the corrected copy of `design-coverage.md` row 5): the target's current state with the honest limit of what
 *    it proves (never attributed to the collided operation), "Discard queued attempt" and, only with `rebuild`, "Review and save as a
 *    new attempt";
 *  - the ONLINE-ONLY variant: nothing to compare or resend.
 *
 * "Currently saved" is the result of the kind's AUTHORISED CURRENT-STATE read (`actions.readCurrent`, an ordinary stamped request; R7 of
 * the review of 10 October 2026), never the cache, which may predate the conflict, be paused or offline, or still hold a resource whose
 * access has changed. Its four states are kept apart: loading (the new attempt is disabled), loaded (compared, and the value the new
 * attempt is rebuilt on), indeterminate (shown plainly, nothing forced), and failed ("Couldn't load the current state of this item to
 * compare.", the new attempt disabled until the person explicitly continues without it). Discarding needs no read.
 *
 * No command-specific comparison is invented (no command kind exists yet): a feature slice's registered description is the title. All
 * copy not quoted from the wireframe is PROPOSED, pending Kieran's visual and copy sign-off. Closing the dialog keeps the change.
 */
export type DetailVariant =
  | "version_conflict"
  | "operation_conflict"
  | "online_only";

export function detailVariant(
  draft: DraftRow,
  onlineOnly: boolean,
): DetailVariant | null {
  if (onlineOnly && (draft.status === "rejected" || draft.status === "blocked"))
    return "online_only";
  if (draft.status === "version_conflict") return "version_conflict";
  if (draft.status === "operation_conflict") return "operation_conflict";
  return null;
}

/** The reference code of the footer: a short, content-free form of the draft's own id (it is the request's idempotency key). */
const refOf = (localId: string): string =>
  localId
    .replace(/-/g, "")
    .slice(0, 8)
    .replace(/^(.{4})(.{4})$/, "$1-$2");

export function ItemDetailDialog({
  draft,
  title,
  variant,
  open,
  onClose,
  onRemoved,
}: {
  draft: DraftRow;
  title: string;
  variant: DetailVariant;
  open: boolean;
  onClose(): void;
  /** The draft left the queue (discarded or superseded): focus goes somewhere stable. */
  onRemoved(): void;
}) {
  const env = useDataEnv();
  const actions = useDataActions();
  const announcer = useAnnouncer();
  const target = draft.target_resource_ids[0];
  const current = useCurrentRead(
    draft.local_id,
    open && variant !== "online_only" && target !== undefined,
  );
  const rebuildable = env.commands.canRebuild(draft);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [proceed, setProceed] = useState(false);

  const read =
    target === undefined
      ? ("indeterminate" as const)
      : current === null
        ? ("loading" as const)
        : current.kind === "loaded"
          ? ("loaded" as const)
          : current.kind === "indeterminate"
            ? ("indeterminate" as const)
            : ("failed" as const);
  const base: CacheRow | null =
    current !== null && current.kind === "loaded" ? current.value : null;

  const discard = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    const out = await actions.discard(draft.local_id).catch(() => null);
    setBusy(false);
    if (out !== null && out.kind === "discarded") {
      onClose();
      onRemoved();
      window.setTimeout(() => announcer.announce(DISCARDED), 250);
      return;
    }
    setConfirming(false);
    setFailed(DISCARD_FAILED);
    announcer.announce(DISCARD_FAILED, "assertive");
  };
  const saveAsNew = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    // Rebuilt on the value the person reviewed (null when they explicitly continued without it), never on the cache, with the other rows
    // that read returned for the rebuild's checks.
    const out = await actions
      .saveAsNew(
        draft.local_id,
        base,
        current?.kind === "loaded" ? current.related : undefined,
      )
      .catch(() => null);
    setBusy(false);
    if (out !== null && out.kind === "superseded") {
      onClose();
      onRemoved();
      return;
    }
    setFailed(DETAIL_SAVE_NEW_FAILED);
    announcer.announce(DETAIL_SAVE_NEW_FAILED, "assertive");
  };

  const heading =
    variant === "operation_conflict"
      ? DETAIL_OPERATION_TITLE
      : DETAIL_VERSION_TITLE;
  const kind =
    variant === "operation_conflict"
      ? DETAIL_OPERATION_KIND
      : variant === "version_conflict"
        ? DETAIL_VERSION_KIND
        : null;
  const ref = refOf(draft.local_id);
  // The new attempt waits for the read: allowed once it has loaded or is shown as indeterminate, or after the person explicitly continues
  // without it when it failed. Never while it is loading.
  const newAllowed =
    read === "loaded" ||
    read === "indeterminate" ||
    (read === "failed" && proceed);

  const footer =
    variant === "online_only" ? null : confirming ? (
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-sm text-foreground">
          {DISCARD_CONFIRM}
        </span>
        <Button onClick={() => setConfirming(false)}>
          {DISCARD_CONFIRM_NO}
        </Button>
        {busy ? (
          <Button disabled reason="Working…">
            {DISCARD_CONFIRM_YES}
          </Button>
        ) : (
          <Button variant="default" onClick={() => void discard()}>
            {DISCARD_CONFIRM_YES}
          </Button>
        )}
      </div>
    ) : (
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="mr-auto font-num text-xs text-muted-foreground">
          {DETAIL_REF(ref)} ·{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void navigator.clipboard?.writeText(ref)}
          >
            {DETAIL_COPY}
          </button>
        </span>
        <Button onClick={() => setConfirming(true)}>
          {variant === "operation_conflict"
            ? DETAIL_DISCARD_ATTEMPT
            : DETAIL_DISCARD_MINE}
        </Button>
        {rebuildable ? (
          newAllowed && !busy ? (
            <Button variant="default" onClick={() => void saveAsNew()}>
              {variant === "operation_conflict"
                ? DETAIL_SAVE_NEW
                : DETAIL_RESEND}
            </Button>
          ) : (
            <Button
              disabled
              reason={
                busy
                  ? "Working…"
                  : read === "loading"
                    ? DETAIL_READ_LOADING
                    : DETAIL_READ_FAILED
              }
            >
              {variant === "operation_conflict"
                ? DETAIL_SAVE_NEW
                : DETAIL_RESEND}
            </Button>
          )
        ) : null}
      </div>
    );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={variant === "online_only" ? title : heading}
      {...(kind === null ? {} : { description: `“${title}” · ${kind}` })}
      {...(footer === null ? {} : { footer })}
    >
      <div
        data-item-detail={variant}
        className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground"
      >
        {variant === "online_only" ? (
          <p>{DETAIL_ONLINE_ONLY}</p>
        ) : (
          <>
            <p>
              {variant === "operation_conflict"
                ? DETAIL_OPERATION_BODY
                : DETAIL_VERSION_BODY}
            </p>
            <div className="grid gap-2 tablet:grid-cols-2">
              <section
                aria-label={
                  variant === "operation_conflict"
                    ? DETAIL_CURRENTLY_SAVED_ON(title)
                    : DETAIL_CURRENTLY_SAVED
                }
                data-compare="current"
                className="rounded-lg border border-border bg-card p-3"
              >
                <h3 className="text-xs font-medium text-foreground">
                  {variant === "operation_conflict"
                    ? DETAIL_CURRENTLY_SAVED_ON(title)
                    : DETAIL_CURRENTLY_SAVED}
                </h3>
                {read === "loaded" && base !== null ? (
                  <>
                    <p className="text-foreground">{base.label}</p>
                    <p className="font-num text-xs">
                      {DETAIL_VERSION(base.version)}
                    </p>
                    {variant === "operation_conflict" ? (
                      <p className="text-xs">{DETAIL_OPERATION_LIMIT}</p>
                    ) : null}
                  </>
                ) : read === "loading" ? (
                  <p aria-busy="true">…</p>
                ) : read === "failed" ? (
                  <>
                    <p>{DETAIL_READ_FAILED}</p>
                    {rebuildable && !proceed ? (
                      <Button onClick={() => setProceed(true)}>
                        {DETAIL_PROCEED_WITHOUT}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p>{DETAIL_INDETERMINATE}</p>
                )}
              </section>
              {variant === "version_conflict" ? (
                <section
                  aria-label={DETAIL_RETAINED}
                  data-compare="retained"
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <h3 className="text-xs font-medium text-foreground">
                    {DETAIL_RETAINED}
                  </h3>
                  <p className="text-foreground">{title}</p>
                  <p className="font-num text-xs">
                    {DETAIL_QUEUED_SINCE(
                      formatSavedAt(draft.created_at, new Date()),
                    )}
                  </p>
                </section>
              ) : null}
            </div>
          </>
        )}
        {failed ? <p className="text-foreground">{failed}</p> : null}
      </div>
    </Dialog>
  );
}

/**
 * The authorised current-state read of the dialog's target (R7): asked once each time the dialog opens, cancelled when it closes. `null`
 * while it loads. A failure of the call itself is a failed read, never "loaded".
 */
function useCurrentRead(localId: string, enabled: boolean): CurrentRead | null {
  const actions = useDataActions();
  const [result, setResult] = useState<CurrentRead | null>(null);
  useEffect(() => {
    setResult(null);
    if (!enabled) return;
    const controller = new AbortController();
    let live = true;
    actions
      .readCurrent(localId, controller.signal)
      .catch((): CurrentRead => ({ kind: "failed", reason: "error" }))
      .then((answer) => {
        if (live) setResult(answer);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [actions, localId, enabled]);
  return result;
}
