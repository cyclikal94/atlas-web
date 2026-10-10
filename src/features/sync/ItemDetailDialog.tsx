import { useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import {
  type DraftRow,
  useCachedResource,
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
 *  - a VERSION CONFLICT: the resource as it is saved now (an ordinary authorised read of the cache, never the overlay) beside the
 *    retained, unsent change, with "Discard mine" and, ONLY when the command's slice registered `rebuild`, "Resend as a new operation";
 *  - an OPERATION CONFLICT (the corrected copy of `design-coverage.md` row 5): the target's current state with the honest limit of what
 *    it proves, "Discard queued attempt" and, only with `rebuild`, "Review and save as a new attempt", disabled until the read has
 *    loaded, or until the person explicitly continues without it when the read fails;
 *  - the ONLINE-ONLY variant: nothing to compare or resend.
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
  const current = useCachedResource(target ?? "");
  const rebuildable = env.commands.canRebuild(draft);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [proceed, setProceed] = useState(false);

  const read =
    target === undefined
      ? ("indeterminate" as const)
      : current.status === "ready"
        ? current.value.base === null
          ? ("indeterminate" as const)
          : ("loaded" as const)
        : current.status === "loading"
          ? ("loading" as const)
          : ("failed" as const);
  const base = current.status === "ready" ? current.value.base : null;

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
    const out = await actions.saveAsNew(draft.local_id).catch(() => null);
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
  const newAllowed =
    variant === "operation_conflict" ? read === "loaded" || proceed : true;

  const footer =
    variant === "online_only" ? null : confirming ? (
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[13px] text-ink-1">
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
          <Button variant="primary" onClick={() => void discard()}>
            {DISCARD_CONFIRM_YES}
          </Button>
        )}
      </div>
    ) : (
      <div className="flex w-full flex-wrap items-center gap-2">
        <span className="mr-auto font-num text-[11.5px] text-ink-2">
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
            <Button variant="primary" onClick={() => void saveAsNew()}>
              {variant === "operation_conflict"
                ? DETAIL_SAVE_NEW
                : DETAIL_RESEND}
            </Button>
          ) : (
            <Button disabled reason={busy ? "Working…" : DETAIL_READ_FAILED}>
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
        className="flex flex-col gap-3 text-[13.5px] leading-[1.6] text-ink-2"
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
                className="rounded-row border border-hairline-strong bg-panel p-3"
              >
                <h3 className="text-[12.5px] font-medium text-ink-1">
                  {variant === "operation_conflict"
                    ? DETAIL_CURRENTLY_SAVED_ON(title)
                    : DETAIL_CURRENTLY_SAVED}
                </h3>
                {read === "loaded" && base !== null ? (
                  <>
                    <p className="text-ink-1">{base.label}</p>
                    <p className="font-num text-[12px]">
                      {DETAIL_VERSION(base.version)}
                    </p>
                    {variant === "operation_conflict" ? (
                      <p className="text-[12px]">{DETAIL_OPERATION_LIMIT}</p>
                    ) : null}
                  </>
                ) : read === "loading" ? (
                  <p aria-busy="true">…</p>
                ) : read === "failed" ? (
                  <>
                    <p>{DETAIL_READ_FAILED}</p>
                    {variant === "operation_conflict" &&
                    rebuildable &&
                    !proceed ? (
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
                  className="rounded-row border border-hairline-strong bg-panel p-3"
                >
                  <h3 className="text-[12.5px] font-medium text-ink-1">
                    {DETAIL_RETAINED}
                  </h3>
                  <p className="text-ink-1">{title}</p>
                  <p className="font-num text-[12px]">
                    {DETAIL_QUEUED_SINCE(
                      formatSavedAt(draft.created_at, new Date()),
                    )}
                  </p>
                </section>
              ) : null}
            </div>
          </>
        )}
        {failed ? <p className="text-ink-1">{failed}</p> : null}
      </div>
    </Dialog>
  );
}
