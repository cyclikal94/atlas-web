import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { useCachedResources } from "../../../data";
import type { PeopleFailure, Projection } from "../api";
import { FieldValueView } from "../detail/FieldValueView";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { useShown } from "../lifetime";
import { useMemoryRevision } from "../memory";
import {
  type ComparisonCell,
  comparisonRows,
  conflictLabels,
  type MergeField,
  type MergePreview,
  mergeBody,
  mergeNaming,
  mergeRecipient,
  type RecipientPreview,
  requestMergeBody,
  respondBody,
  timeLeft,
} from "../model/requests";
import { Banner, Choices } from "../parts";
import { linkageIn, readLinkage, usePersonLinkage } from "../reads";
import {
  blockedReason,
  commonFailure,
  reportOutcome,
  reportUnder,
  retainedUnder,
  runCommand,
  runCommandFrom,
} from "./commands";
import * as copy from "./copy";
import {
  captureMergeName,
  chooseMergeName,
  consumeMergeName,
  type MergeNameDraft,
  mergeNameChoice,
  mergeNameDraft,
} from "./mergeName";
import {
  askAgain,
  currentOf,
  previewKey,
  type Refusable,
  reviewKey,
  useIncoming,
  useMergePreview,
  usePersonSummary,
  useRecipientPreview,
} from "./reads";
import { useSenderName } from "./sender";

/**
 * WF-PEOPLE-05, the merge dialog (§4.3, §4.6), as the SENDER sees it (`SenderMerge`: "Compare & merge" over the duplicates, or "Compare"
 * in "Ask to merge") and as the RECIPIENT of a merge request sees it (`RecipientReview`, from "See what changes"). The shared `Dialog`: a
 * full-height sheet with a sticky footer below 768 px, the in-dialog sync chip in its header.
 *
 * ORDER (also the focus order): "Name after merging", the comparison, the conflict note, the consequence note ("Merging fixes who can see
 * what, permanently"), then the footer with the action: the consequence is reached BEFORE the button.
 *
 * Every press uses the comparison SHOWN: the token of the preview this render drew, and only while it is still the current read (a newer
 * one is shown first; a read after an invalidation disables the action until it answers). A `409` reads the comparison again and nothing
 * is resent by itself.
 */
export const mergeKey = (sourceId: string, targetId: string): string =>
  `merge:${sourceId}:${targetId}`;
export const RESPOND_PREFIX = "respond:";
export const respondKey = (requestId: string): string =>
  `${RESPOND_PREFIX}${requestId}`;

// ---- the comparison ------------------------------------------------------------------------------------------------------------
function Cell({
  cell,
  hidden,
}: {
  cell: ComparisonCell | null;
  hidden: boolean;
}) {
  if (hidden)
    return (
      <span className="text-xs text-muted-foreground">{copy.NOT_VISIBLE}</span>
    );
  if (cell === null)
    return <span className="text-muted-foreground">{copy.NONE}</span>;
  if (cell.kind === "name")
    return <span className="text-sm text-foreground">{cell.text}</span>;
  if (cell.kind === "unsynced")
    return (
      <span
        className="text-xs text-muted-foreground"
        data-comparison-unsynced=""
      >
        {copy.NOT_ON_DEVICE}
      </span>
    );
  // R5 of review 1: every cell inherits the page's `overflow-wrap: anywhere` (`styles/base.css`), but the shared value renderer sets
  // `break-words` on its text, whose MINIMUM width is still a whole unbroken word: a valid 500-character word then widened the table far
  // past the dialog. Here the value's text may break anywhere again, so it wraps within its column.
  return <FieldValueView raw={cell.row.value} anywhere />;
}

/** The side-by-side table (D-11b-6): the kept person first. Values only from this device's synced rows at the preview's version. */
function Comparison({
  preview,
}: {
  preview: {
    source: Projection | null;
    target: Projection | null;
    fields: readonly MergeField[];
  };
}) {
  const ids = preview.fields.map((field) => field.id);
  const cached = useCachedResources(ids);
  const rows = comparisonRows(preview, (id) => {
    if (cached.status !== "ready") return null;
    const listed = cached.value[id];
    if (listed === null || listed === undefined) return null;
    const { kind_date: _date, ...row } = listed.base;
    return row;
  });
  const targetName = preview.target?.label ?? copy.NOT_VISIBLE;
  const sourceName = preview.source?.label ?? copy.NOT_VISIBLE;
  return (
    // BOUNDED columns (R5 of review 1): every cell may break anywhere (the page's `overflow-wrap`, and the values), so an automatic layout
    // squeezes a column to a character's width beside a long value. Fixed widths keep the field and both people readable; set inline, so
    // they add nothing to the production stylesheet (its budget).
    <table
      className="w-full text-left"
      style={{ tableLayout: "fixed" }}
      data-merge-comparison=""
    >
      <thead>
        <tr className="border-b border-border text-xs text-muted-foreground">
          <th scope="col" className="py-2 font-medium" style={{ width: "28%" }}>
            {copy.FIELD}
          </th>
          <th scope="col" className="py-2 font-medium" style={{ width: "36%" }}>
            {copy.KEPT(targetName)}
          </th>
          <th scope="col" className="py-2 font-medium" style={{ width: "36%" }}>
            {sourceName}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            className="border-b border-border"
            data-comparison-row={row.key}
          >
            <th
              scope="row"
              className="py-2 text-sm font-medium text-foreground"
            >
              {row.label}
            </th>
            <td className="py-2">
              <Cell cell={row.target} hidden={preview.target === null} />
            </td>
            <td className="py-2">
              <Cell cell={row.source} hidden={preview.source === null} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The note under the table: fields both sides have are kept, one as a second entry (the server keeps every field). */
function ConflictNote({
  preview,
}: {
  preview: {
    source: Projection | null;
    target: Projection | null;
    fields: readonly MergeField[];
  };
}) {
  if (preview.source === null || preview.target === null) return null;
  const labels = conflictLabels(preview.fields, {
    sourceId: preview.source.id,
    targetId: preview.target.id,
  });
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-merge-conflicts="">
      {labels.map((label) => (
        <p key={label} className="text-xs leading-[1.55] text-muted-foreground">
          {copy.BOTH_HAVE(label, (preview.source as Projection).label)}
        </p>
      ))}
    </div>
  );
}

/**
 * The consequence, BEFORE the action in reading and focus order (shown whenever the merge freezes field policies). It is a focusable,
 * labelled region: Tab reaches the warning itself before the button (the design's focus-order note), and the dialog's scrolling body
 * always holds something focusable (axe `scrollable-region-focusable`; the recipient's review has no input of its own).
 */
function FreezeNote({ id, freezes }: { id: string; freezes: boolean }) {
  const heading = useId();
  if (!freezes) return null;
  return (
    <section
      id={id}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a labelled region reached by Tab before the action it warns about
      tabIndex={0}
      aria-labelledby={heading}
      data-merge-consequence=""
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3.5"
    >
      <h3 id={heading} className="text-sm font-medium text-foreground">
        {copy.FREEZE_TITLE}
      </h3>
      <p className="text-sm leading-[1.6] text-foreground">
        {copy.FREEZE_BODY}
      </p>
      <p className="text-sm leading-[1.6] text-muted-foreground">
        {copy.FREEZE_BLOCKED}
      </p>
    </section>
  );
}

function ReportBanner({
  env,
  reportKey,
}: {
  env: PeopleEnv;
  reportKey: string;
}) {
  const report = reportUnder(env, reportKey);
  if (report === null) return null;
  return <Banner message={report.text} requestId={report.requestId} />;
}

/** A remembered `403` is asked again only by this explicit action (`reads.ts` `askAgain`, D-12a-13); other refusals offer none. */
function refusedAgain(
  env: PeopleEnv,
  failure: Refusable<unknown> & { ok: false },
  key: string,
): ReactNode {
  if (failure.refusal.kind !== "forbidden" || !env.online) return undefined;
  return (
    <Button
      data-people-action="preview-again"
      onClick={() => askAgain(env, key)}
    >
      {copy.RELOAD}
    </Button>
  );
}

/** The copy of a preview read's refusal (the sender's `POST`; the recipient's `GET` names its own `404`/`410`). */
function previewRefusal(failure: Refusable<unknown> & { ok: false }): string {
  switch (failure.refusal.kind) {
    case "not_found":
      return copy.PREVIEW_NOT_FOUND;
    case "forbidden":
      return copy.PREVIEW_FORBIDDEN;
    case "expired":
      return copy.REQUEST_EXPIRED;
    default:
      return copy.PREVIEW_INVALID;
  }
}

// ---- the sender ------------------------------------------------------------------------------------------------------------------
/**
 * What a sender's merge attempt was made of: a request (and whom it asks) or a direct merge, the name it carries, and the name choice it
 * was captured from (R1 of review 4: the only choice its success may consume; `mergeName.ts`).
 */
interface MergeOrigin {
  approval: boolean;
  name: string;
  owner: string;
  draft: MergeNameDraft;
}

export function SenderMerge({
  sourceId,
  targetId,
  onClose,
}: {
  sourceId: string;
  targetId: string;
  /** Back to the page under the dialog (the duplicates, or Requests). */
  onClose(): void;
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const announcer = useAnnouncer();
  const navigate = useNavigate();
  const shown = useShown();
  const consequence = useId();
  const key = mergeKey(sourceId, targetId);
  const view = useMergePreview(env, sourceId, targetId);
  const now = currentOf(view);
  const previous = view.status === "loading" ? view.previous : null;
  const drawn = now ?? previous;
  const preview = drawn?.value.ok ? drawn.value.value : null;
  // Who controls each profile (D-11b-7): read, never inferred; the server checks only at commit.
  const source = usePersonLinkage(sourceId);
  const target = usePersonLinkage(targetId);
  const naming = preview
    ? mergeNaming(source.linkage, target.linkage, {
        source: preview.source.label,
        target: preview.target.label,
      })
    : null;
  // Who has to accept, from the viewer-safe summaries (D-11b-8); only asked for when approval is needed.
  const needsApproval = preview?.requires_approval === true;
  const sourceSummary = usePersonSummary(env, needsApproval ? sourceId : null);
  const targetSummary = usePersonSummary(env, needsApproval ? targetId : null);
  const recipient = mergeRecipient(
    currentOf(sourceSummary)?.value.summary ?? null,
    currentOf(targetSummary)?.value.summary ?? null,
  );
  const owner = recipient?.username ?? copy.THE_OTHER_OWNER;
  // The choice this render draws (its record is the ticket a press captures).
  const nameDraft = mergeNameDraft(env.memory, sourceId, targetId);
  const chosen = mergeNameChoice(nameDraft);
  const nameOf = (
    shownPreview: MergePreview,
    which: "source" | "target",
  ): string =>
    which === "source" ? shownPreview.source.label : shownPreview.target.label;

  const press = async () => {
    // The comparison this render drew, and only while it is still the current read (never a token of an earlier render); likewise the
    // name choice this render drew, only while it is still the pair's current one.
    const drawnPreview = preview;
    const drawnName = nameDraft;
    const memory = env.memory;
    const sent = await runCommandFrom<MergeOrigin>(env, key, () => {
      const current = currentOf(view);
      if (drawnPreview === null || current === null || !current.value.ok)
        return null;
      if (current.value.value !== drawnPreview) return null;
      // The linkage as the page knows it AT THE PRESS.
      const naming = mergeNaming(
        linkageIn(env, sourceId),
        linkageIn(env, targetId),
        {
          source: drawnPreview.source.label,
          target: drawnPreview.target.label,
        },
      );
      if (naming.kind === "both_linked" || naming.kind === "unknown")
        return null;
      // The choice captured WITH the body, at this original preparation (a replay never calls this: it keeps this capture).
      const draft = captureMergeName(memory, sourceId, targetId, drawnName);
      if (draft === null) return null;
      const name =
        naming.kind === "fixed"
          ? naming.name
          : nameOf(drawnPreview, draft.choice);
      // What this attempt is made of, kept beside it: a replay completes as THIS attempt (R1 of review 1), never as the comparison or
      // the choice shown when Try again is pressed.
      const origin: MergeOrigin = {
        approval: drawnPreview.requires_approval,
        name,
        owner,
        draft,
      };
      return {
        body: drawnPreview.requires_approval
          ? requestMergeBody({
              requestId: env.newId(),
              sourceId,
              targetId,
              token: drawnPreview.token,
              name,
            })
          : mergeBody({ sourceId, targetId, token: drawnPreview.token, name }),
        origin,
      };
    });
    if (sent === null) return;
    const { result, origin } = sent;
    readLinkage(env, sourceId, { force: true });
    readLinkage(env, targetId, { force: true });
    if (result.ok) {
      // Only the choice THIS attempt was made of (R1 of review 4): a choice made after its capture stays, whichever mount shows it.
      consumeMergeName(memory, origin?.draft ?? null);
      if (origin?.approval) {
        announcer.announce(copy.MERGE_REQUESTED(origin.owner), "polite");
        if (shown()) onClose();
      } else {
        if (origin !== null)
          announcer.announce(copy.MERGED_INTO(origin.name), "polite");
        if (shown())
          void navigate({
            to: "/people/$personId",
            params: { personId: result.value.person_id },
          });
      }
      return;
    }
    reportOutcome(env, key, result, (failure) =>
      failure.kind === "conflict"
        ? copy.COMPARISON_CHANGED
        : commonFailure(failure),
    );
  };

  const retained = retainedUnder(env, key);
  const blocked = blockedReason(env, key);
  let body: ReactNode;
  let footer: ReactNode = null;
  let reason: string | null = blocked;
  if (!env.online && drawn === null) {
    body = <Banner message={copy.PREVIEW_OFFLINE} tone="note" />;
  } else if (view.status === "failed") {
    body = (
      <Banner
        message={copy.PREVIEW_FAILED}
        action={<Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>}
      />
    );
  } else if (drawn === null) {
    body = (
      <p className="text-sm text-muted-foreground" data-merge-state="loading">
        {copy.PREVIEW_LOADING}
      </p>
    );
  } else if (!drawn.value.ok) {
    body = (
      <Banner
        message={previewRefusal(drawn.value)}
        requestId={drawn.value.refusal.requestId}
        action={refusedAgain(env, drawn.value, previewKey(sourceId, targetId))}
      />
    );
  } else if (preview !== null && naming !== null) {
    if (reason === null && !retained) {
      reason =
        now === null
          ? copy.LOAD_FIRST
          : naming.kind === "both_linked"
            ? copy.BOTH_LINKED
            : naming.kind === "unknown"
              ? copy.LINKAGE_UNKNOWN
              : null;
    }
    body = (
      <>
        {naming.kind === "both_linked" ? (
          <Banner
            message={copy.BOTH_LINKED}
            action={
              <Button
                onClick={() => {
                  source.retry();
                  target.retry();
                }}
              >
                {copy.RELOAD}
              </Button>
            }
          />
        ) : null}
        <section className="flex flex-col gap-2" data-merge-name="">
          <h3 className="text-sm font-medium text-foreground">
            {copy.NAME_AFTER}
          </h3>
          {naming.kind === "choose" &&
          naming.options[0] !== naming.options[1] ? (
            <Choices
              label={copy.NAME_AFTER}
              value={chosen}
              onChange={(value) =>
                void chooseMergeName(env.memory, sourceId, targetId, value)
              }
              choices={[
                { value: "target", label: preview.target.label },
                { value: "source", label: preview.source.label },
              ]}
            />
          ) : (
            <p className="text-sm text-foreground" data-merge-name-fixed="">
              {naming.kind === "fixed" ? naming.name : preview.target.label}
            </p>
          )}
          {naming.kind === "fixed" ? (
            <p className="text-xs text-muted-foreground">{copy.LINKED_NAME}</p>
          ) : null}
          {naming.kind === "unknown" ? (
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {copy.LINKAGE_UNKNOWN}
              {env.online ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    source.retry();
                    target.retry();
                  }}
                >
                  {copy.TRY_AGAIN}
                </Button>
              ) : null}
            </span>
          ) : null}
        </section>
        <Comparison preview={preview} />
        <ConflictNote preview={preview} />
        <FreezeNote id={consequence} freezes={preview.freezes_field_policies} />
      </>
    );
    const label = needsApproval
      ? copy.ASK_TO_MERGE_WITH(owner)
      : copy.MERGE_THEM;
    footer = (
      <>
        <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            {needsApproval ? copy.HAS_TO_ACCEPT(owner) : copy.OWN_BOTH}
          </span>
          {needsApproval ? <span>{copy.EXPIRES_IN_7}</span> : null}
        </span>
        <Button variant="ghost" onClick={onClose}>
          {copy.CANCEL}
        </Button>
        {reason === null ? (
          <Button
            variant="default"
            data-people-action="confirm-merge"
            aria-describedby={consequence}
            onClick={() => void press()}
          >
            {retained ? copy.TRY_AGAIN : label}
          </Button>
        ) : (
          <Button variant="default" disabled reason={reason}>
            {retained ? copy.TRY_AGAIN : label}
          </Button>
        )}
      </>
    );
  }
  const title = preview
    ? copy.MERGE_TITLE(preview.source.label, preview.target.label)
    : copy.MERGE_TITLE_PLAIN;
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        footer ?? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {copy.CLOSE}
            </Button>
            {/* A retained uncertain merge stays reachable whatever the comparison shows now: it is sent again as it was. */}
            {retained ? (
              blocked === null ? (
                <Button
                  variant="default"
                  data-people-action="confirm-merge"
                  onClick={() => void press()}
                >
                  {copy.TRY_AGAIN}
                </Button>
              ) : (
                <Button variant="default" disabled reason={blocked}>
                  {copy.TRY_AGAIN}
                </Button>
              )
            ) : null}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4" data-merge-dialog="sender">
        <ReportBanner env={env} reportKey={key} />
        {body}
      </div>
    </Dialog>
  );
}

// ---- the recipient ---------------------------------------------------------------------------------------------------------------
/** The answer a retained uncertain respond attempt carried (null: none kept): its Try again sends THAT answer again. */
export function retainedAnswer(env: PeopleEnv, key: string): boolean | null {
  const attempt = env.memory.attempts.get(key);
  if (attempt === undefined) return null;
  try {
    const accept = (
      JSON.parse(attempt.body) as { command?: { accept?: unknown } }
    ).command?.accept;
    return typeof accept === "boolean" ? accept : null;
  } catch {
    return null;
  }
}

/**
 * Sends an answer to request `requestId` (§3.4): the retained uncertain answer again exactly when it is the same answer; a DIFFERENT
 * answer while one is uncertain is refused (never a second, contradictory answer).
 */
export async function answerRequest(
  env: PeopleEnv,
  requestId: string,
  accept: boolean,
  prepare: () => unknown | null,
): Promise<Awaited<ReturnType<typeof runCommand>>> {
  const key = respondKey(requestId);
  const earlier = retainedAnswer(env, key);
  if (earlier !== null && earlier !== accept) {
    env.memory.requestReports.set(key, {
      text: copy.ANSWER_UNCERTAIN_FIRST,
      uncertain: true,
    });
    env.memory.touch();
    return null;
  }
  return runCommand(env, key, prepare);
}

/** The copy of a respond answer that is not a success (D-11b-9). */
export function respondFailure(
  failure: PeopleFailure,
  kind: "link" | "merge",
  sender: string,
): string | null {
  if (failure.kind === "conflict")
    return kind === "merge"
      ? copy.MERGE_CHANGED
      : copy.LINK_OUT_OF_DATE(sender);
  return commonFailure(failure);
}

export function RecipientReview({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose(): void;
}) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const announcer = useAnnouncer();
  const navigate = useNavigate();
  const shown = useShown();
  const consequence = useId();
  const key = respondKey(requestId);
  const view = useRecipientPreview(env, requestId);
  const incoming = useIncoming(env);
  const listed =
    currentOf(incoming) ??
    (incoming.status === "loading" ? incoming.previous : null);
  const request = listed?.value.ok
    ? (listed.value.value.find((item) => item.id === requestId) ?? null)
    : null;
  const sender = useSenderName(env, request?.sender_id ?? null);
  const senderText = sender ?? copy.SOMEONE;
  const now = currentOf(view);
  const drawn = now ?? (view.status === "loading" ? view.previous : null);
  const preview: RecipientPreview | null = drawn?.value.ok
    ? drawn.value.value
    : null;
  // The pre-check over the identities the recipient can see (D-11b-7); a hidden one cannot be checked (the server decides).
  const sourceLinkage = usePersonLinkage(preview?.source?.id ?? null).linkage;
  const targetLinkage = usePersonLinkage(preview?.target?.id ?? null).linkage;
  const bothVisible =
    preview !== null && preview.source !== null && preview.target !== null;
  const naming =
    preview && bothVisible
      ? mergeNaming(sourceLinkage, targetLinkage, {
          source: (preview.source as Projection).label,
          target: (preview.target as Projection).label,
        })
      : null;

  // A request the server says is gone or expired: the lists are read again (its row disappears), once per dialog. Only for those: a `403`
  // remounts the protected tree, so a re-read on it would run again on every mount (N1 of revision 1).
  const refused =
    drawn !== null &&
    !drawn.value.ok &&
    (drawn.value.refusal.kind === "not_found" ||
      drawn.value.refusal.kind === "expired")
      ? drawn.value.refusal.kind
      : null;
  const reread = useRef(false);
  useEffect(() => {
    if (refused === null || reread.current) return;
    reread.current = true;
    env.memory.invalidateSummaries();
  }, [refused, env]);

  const respond = async (accept: boolean) => {
    const drawnPreview = preview;
    const result = await answerRequest(env, requestId, accept, () => {
      if (!accept) return respondBody({ requestId, accept: false });
      const current = currentOf(view);
      if (drawnPreview === null || current === null || !current.value.ok)
        return null;
      if (current.value.value !== drawnPreview) return null;
      return respondBody({
        requestId,
        accept: true,
        recipientToken: drawnPreview.token,
      });
    });
    if (result === null) return;
    if (result.ok) {
      announcer.announce(
        accept ? copy.MERGE_ACCEPTED : copy.DECLINED,
        "polite",
      );
      if (!shown()) return;
      if (accept)
        void navigate({
          to: "/people/$personId",
          params: { personId: result.value.person_id },
        });
      else onClose();
      return;
    }
    reportOutcome(env, key, result, (failure) =>
      respondFailure(failure, "merge", senderText),
    );
  };

  const retained = retainedAnswer(env, key);
  const blocked = blockedReason(env, key);
  const expired =
    drawn !== null && !drawn.value.ok && drawn.value.refusal.kind === "expired";
  let body: ReactNode;
  let acceptReason: string | null = blocked;
  if (!env.online && drawn === null) {
    body = <Banner message={copy.PREVIEW_OFFLINE} tone="note" />;
  } else if (view.status === "failed") {
    body = (
      <Banner
        message={copy.PREVIEW_FAILED}
        action={<Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>}
      />
    );
  } else if (drawn === null) {
    body = (
      <p className="text-sm text-muted-foreground" data-merge-state="loading">
        {copy.PREVIEW_LOADING}
      </p>
    );
  } else if (!drawn.value.ok) {
    const kind = drawn.value.refusal.kind;
    body = (
      <Banner
        message={
          kind === "expired"
            ? copy.REQUEST_EXPIRED
            : kind === "not_found"
              ? copy.REQUEST_GONE
              : previewRefusal(drawn.value)
        }
        requestId={drawn.value.refusal.requestId}
        action={refusedAgain(env, drawn.value, reviewKey(requestId))}
      />
    );
  } else if (preview !== null) {
    if (acceptReason === null && retained !== true)
      acceptReason =
        now === null
          ? copy.LOAD_FIRST
          : naming?.kind === "both_linked"
            ? copy.RECIPIENT_BOTH_LINKED
            : naming?.kind === "unknown" ||
                (preview.source !== null && !sourceLinkage.known) ||
                (preview.target !== null && !targetLinkage.known)
              ? copy.LINKAGE_UNKNOWN
              : null;
    const left = request ? timeLeft(request.expires_at, env.now()) : null;
    body = (
      <>
        <p className="text-xs text-muted-foreground" data-review-asked="">
          {copy.ASKED(senderText)}
          {left ? ` · ${timeLeftText(left)}` : ""}
        </p>
        {sender === null ? (
          <p className="text-xs text-muted-foreground">
            {copy.UNNAMED_CAUTION}
          </p>
        ) : null}
        {preview.stale ? (
          <Banner message={copy.STALE(senderText)} tone="note" />
        ) : null}
        {request?.proposal.kind === "merge" ? (
          <section className="flex flex-col gap-1" data-merge-name="">
            <h3 className="text-sm font-medium text-foreground">
              {copy.NAME_AFTER}
            </h3>
            <p className="text-sm text-foreground">{request.proposal.name}</p>
          </section>
        ) : null}
        {bothVisible ? (
          <Comparison preview={preview} />
        ) : (
          <div className="flex flex-col gap-2" data-merge-partial="">
            <Comparison preview={preview} />
            <h3 className="text-sm font-medium text-foreground">
              {copy.COMPARISON_UNAVAILABLE}
            </h3>
            <p className="text-sm leading-[1.6] text-muted-foreground">
              {copy.PARTIAL_VIEW(senderText)}
            </p>
            <p className="text-sm leading-[1.6] text-muted-foreground">
              {copy.PARTIAL_CHECKS(senderText)}
            </p>
            <p className="text-xs text-muted-foreground">
              {copy.CANNOT_CHECK_HIDDEN}
            </p>
          </div>
        )}
        <ConflictNote preview={preview} />
        <FreezeNote id={consequence} freezes={preview.freezes_field_policies} />
      </>
    );
  }
  const gone = drawn !== null && !drawn.value.ok && !expired;
  const declineReason = blocked;
  // A retained uncertain answer stays reachable whatever the preview shows now (it is sent again as it was).
  const footer =
    gone && retained === null ? (
      <Button variant="ghost" onClick={onClose}>
        {copy.CLOSE}
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose}>
          {copy.CLOSE}
        </Button>
        {declineReason === null ? (
          <Button
            data-people-action="decline-merge"
            onClick={() => void respond(false)}
          >
            {retained === false ? copy.TRY_AGAIN : copy.DECLINE}
          </Button>
        ) : (
          <Button disabled reason={declineReason}>
            {copy.DECLINE}
          </Button>
        )}
        {expired && retained !== true ? null : acceptReason === null &&
          (preview !== null || retained === true) ? (
          <Button
            variant="default"
            data-people-action="accept-merge"
            aria-describedby={consequence}
            onClick={() => void respond(true)}
          >
            {retained === true ? copy.TRY_AGAIN : copy.ACCEPT}
          </Button>
        ) : (
          <Button
            variant="default"
            disabled
            reason={acceptReason ?? copy.LOAD_FIRST}
          >
            {copy.ACCEPT}
          </Button>
        )}
      </>
    );
  return (
    <Dialog
      open
      title={copy.MERGE_TITLE_PLAIN}
      onClose={onClose}
      footer={footer}
    >
      <div className="flex flex-col gap-4" data-merge-dialog="recipient">
        <ReportBanner env={env} reportKey={key} />
        {body}
      </div>
    </Dialog>
  );
}

export function timeLeftText(left: ReturnType<typeof timeLeft>): string {
  switch (left.kind) {
    case "days":
      return copy.TIME_LEFT.days(left.n);
    case "hours":
      return copy.TIME_LEFT.hours(left.n);
    case "under_hour":
      return copy.TIME_LEFT.under_hour;
    case "due":
      return copy.TIME_LEFT.due;
  }
}
