import { useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { List } from "../../components/ui/list";
import {
  type CapturedAccount,
  type CapturedHousehold,
  captureDefaults,
  type DefaultsRecord,
  type DefaultTemplate,
  type DraftRow,
  defaultsReviewCase,
  parseDefaultsContext,
  type RequestBoundary,
  reviewedOf,
  reviewKinds,
  type SnapshotHousehold,
  type TemplateKind,
  useDataActions,
  useSharingDefaults,
} from "../../data";
import * as copy from "./copy";
import { SharingBoundary, useSharingEnv } from "./env";
import { anonymousLabel } from "./model/audience";
import { freshForReview } from "./model/review";
import {
  describeTemplate,
  KIND_SHARING,
  memberLabels,
} from "./model/templates";
import { Banner, formatWhen } from "./parts";

/**
 * The defaults review (WEB-04 §5.7; design-coverage §4c; `sharing-preview-proposed.html`), opened from the `/sync` queue's
 * defaults-review rows. One "Was / Now" section per template kind the draft consumes, each with the member list of every household the
 * template names, so a membership-only change is visible even when the template is unchanged (F7a). "Was" is the audience captured with
 * the draft (keyed to its revision); "Now" is shown only from a snapshot fetched AFTER the review opened. The copy is one of the four
 * cases, and only the draft that was sent and refused is told the defaults "have changed".
 *
 * Confirm is the person's explicit approval and the ONLY thing that releases the draft (a background fetch never does): the stored
 * command is resent with the reviewed revision (an edit in place for a draft never sent; a supersession for one the server refused).
 * Discard removes it (a defaults review is discardable: nothing was applied).
 *
 * The review covers EVERY kind the draft consumes, not only those its block names (R3), and each audience is shown principal by
 * principal: each household with its access and members, each account granted directly with its access, each exclusion (R4). "Was" is
 * labelled only from what was captured with the draft and "Now" only from the current snapshot; an account neither names is shown by an
 * abbreviated id. The confirmation is conditional on the draft exactly as shown (R2): edited elsewhere meanwhile, it is refused and the
 * person reviews it again.
 *
 * "Now" is the snapshot the review's OWN read fetched, asked for after the review opened (WEB-12a review 2, R7): a read already under
 * way when it opened is not waited for or accepted, and an answer that still predates the opening is a failure the person can retry,
 * never an endless "loading". That snapshot is the one shown AND the one confirmed. Confirm needs the connection and that read
 * (plan §4.6): offline, or after the connection returns until the review's read lands again, it is disabled with its reason. The read
 * after the connection returns, and a Try again, must each follow THEIR OWN start (DA-C1): a read still under way from before is not
 * accepted for them.
 */
export function DefaultsReview({
  draft,
  onClose,
}: {
  draft: DraftRow;
  onClose(): void;
}) {
  return (
    <SharingBoundary>
      <ReviewDialogFor draft={draft} onClose={onClose} />
    </SharingBoundary>
  );
}

/** One review per displayed identity and draft: either changing opens a new review, with its own opening and read (R7). */
function ReviewDialogFor(props: { draft: DraftRow; onClose(): void }) {
  const env = useSharingEnv();
  return (
    <ReviewDialog
      key={`${env.identity}\u0000${props.draft.local_id}`}
      {...props}
    />
  );
}

type Status =
  | { kind: "loading" }
  | { kind: "offline" }
  | { kind: "failed" }
  | { kind: "ready"; record: DefaultsRecord };

function ReviewDialog({
  draft,
  onClose,
}: {
  draft: DraftRow;
  onClose(): void;
}) {
  const env = useSharingEnv();
  const defaults = useSharingDefaults();
  const actions = useDataActions();
  const announcer = useAnnouncer();
  const [openedAt] = useState(() => env.now());
  // The review's place in the source's reads as it opened: only a read issued after it can be "Now" (R7).
  const [opened] = useState(() => defaults.boundary());
  // The replacement's identity, chosen once: a retry of a confirmation whose completion was lost uses the same one (R24).
  const [replacementId] = useState(() => env.newId());
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // Each load supersedes the one before: an earlier answer landing late never replaces a newer state.
  const loads = useRef(0);
  // What the current load's read must follow: the opening for the first load; a load after the connection returns, or a Try again,
  // renews it (DA-C1), so a read already under way before the connection dropped (or before the retry) can never be "Now".
  const since = useRef<{ after: RequestBoundary | null; at: number }>({
    after: opened,
    at: openedAt,
  });
  const loaded = useRef(false);

  const load = () => {
    const current = ++loads.current;
    if (loaded.current)
      since.current = { after: defaults.boundary(), at: env.now() };
    loaded.current = true;
    if (!env.online) {
      setStatus({ kind: "offline" });
      return;
    }
    setStatus({ kind: "loading" });
    const settle = (next: Status) => {
      if (mounted.current && current === loads.current) setStatus(next);
    };
    const { after, at } = since.current;
    defaults.acquire(after).then(
      (got) => {
        // The read's own snapshot, still checked against the time its load began: one that predates it is never "Now" (a clock that
        // went back), and the person can try again.
        const fresh =
          got.outcome === "fetched" ? freshForReview(got.record, at) : null;
        settle(
          fresh !== null
            ? { kind: "ready", record: fresh }
            : got.outcome === "offline"
              ? { kind: "offline" }
              : { kind: "failed" },
        );
      },
      () => settle({ kind: "failed" }),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked when the review opens and when the page comes back online
  useEffect(load, [env.online]);

  const now = status.kind === "ready" ? status.record : null;
  const kinds = reviewKinds(draft);
  const was = parseDefaultsContext(draft.defaults_context);
  const reviewCase =
    now === null ? null : defaultsReviewCase(draft, now.snapshot);
  const heading =
    copy.REVIEW_HEADINGS[
      reviewCase ?? (was === null ? "never_fetched" : "review_unchanged")
    ];

  const confirm = async () => {
    if (now === null) return;
    const capture = captureDefaults(now, kinds);
    setBusy(true);
    setProblem(null);
    const out = await actions
      .confirmDefaultsReview(draft.local_id, {
        // Exactly the draft this review shows: changed meanwhile, the confirmation is refused (`draft_changed`), never applied to it.
        reviewed: reviewedOf(draft),
        defaultsRevision: capture.defaultsRevision as string,
        defaultsContext: capture.defaultsContext,
        replacementId,
      })
      .catch(() => null);
    if (!mounted.current) return;
    setBusy(false);
    if (out?.kind === "confirmed") {
      announcer.announce(copy.REVIEW_CONFIRMED);
      onClose();
      return;
    }
    const reason = out?.kind === "refused" ? out.reason : null;
    setProblem(
      reason === "not_found" || reason === "not_reviewing"
        ? copy.REVIEW_GONE
        : reason === "rebuild_refused"
          ? copy.REVIEW_OWN_SCREEN
          : reason === "draft_changed"
            ? copy.REVIEW_CHANGED
            : copy.REVIEW_FAILED,
    );
  };

  const discard = async () => {
    setBusy(true);
    setProblem(null);
    const out = await actions.discard(draft.local_id).catch(() => null);
    if (!mounted.current) return;
    setBusy(false);
    if (out?.kind === "discarded") {
      announcer.announce(copy.REVIEW_DISCARDED);
      onClose();
      return;
    }
    setProblem(
      out?.kind === "refused" && out.reason === "not_found"
        ? copy.REVIEW_GONE
        : copy.REVIEW_DISCARD_FAILED,
    );
  };

  const confirmReason =
    now === null || !env.online
      ? !env.online || status.kind === "offline"
        ? copy.REVIEW_NOW_NEEDS_CONNECTION
        : copy.REVIEW_CONFIRM_REASON
      : !env.writable
        ? copy.SAVE_COMPAT_REASON
        : busy
          ? copy.SAVE_BUSY_REASON
          : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={copy.REVIEW_TITLE}
      footer={
        <>
          {busy ? (
            <Button disabled reason={copy.SAVE_BUSY_REASON}>
              {copy.REVIEW_DISCARD}
            </Button>
          ) : (
            <Button onClick={() => void discard()}>
              {copy.REVIEW_DISCARD}
            </Button>
          )}
          {confirmReason === null ? (
            <Button
              variant="primary"
              data-confirm=""
              onClick={() => void confirm()}
            >
              {copy.REVIEW_CONFIRM}
            </Button>
          ) : (
            <Button
              variant="primary"
              data-confirm=""
              disabled
              reason={confirmReason}
            >
              {copy.REVIEW_CONFIRM}
            </Button>
          )}
        </>
      }
    >
      <div
        className="flex flex-col gap-4"
        data-review-case={reviewCase ?? "pending"}
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[15px] font-medium text-ink-1">{heading}</h2>
          {reviewCase !== null ? (
            <p className="text-[13px] leading-[1.6] text-ink-2">
              {copy.REVIEW_BODIES[reviewCase]}
            </p>
          ) : null}
        </div>
        {(kinds.length > 0 ? kinds : (["person"] as TemplateKind[])).map(
          (kind) => (
            <KindSection
              key={kind}
              kind={kind}
              was={was?.kinds[kind] ?? null}
              wasRevision={was?.revision ?? null}
              wasPrimary={was?.primary_household_id ?? null}
              now={
                now === null
                  ? null
                  : {
                      template: now.snapshot.defaults[kind],
                      primary: now.snapshot.defaults.primary_household_id,
                      households: now.snapshot.households,
                      at: formatWhen(now.fetched_at, env.now()),
                    }
              }
              status={status}
              onRetry={load}
            />
          ),
        )}
        {problem ? <Banner message={problem} /> : null}
      </div>
    </Dialog>
  );
}

function KindSection({
  kind,
  was,
  wasRevision,
  wasPrimary,
  now,
  status,
  onRetry,
}: {
  kind: TemplateKind;
  was: {
    template: DefaultTemplate;
    households: CapturedHousehold[];
    accounts?: CapturedAccount[];
  } | null;
  wasRevision: string | null;
  wasPrimary: string | null;
  now: {
    template: DefaultTemplate;
    primary: string | null;
    households: SnapshotHousehold[];
    at: string;
  } | null;
  status: Status;
  onRetry(): void;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-review-kind={kind}
      className="flex flex-col gap-3 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <h3 id={heading} className="text-[13.5px] font-medium text-ink-1">
        {KIND_SHARING[kind]}
      </h3>
      <div className="flex flex-col gap-1" data-review-was="">
        <h4 className="text-[12.5px] font-medium text-ink-2">
          {copy.REVIEW_WAS}
        </h4>
        {was === null ? (
          <p className="text-[13px] text-ink-1">{copy.REVIEW_NOT_RECORDED}</p>
        ) : (
          <>
            <Described
              template={was.template}
              primary={wasPrimary}
              households={was.households}
              accounts={was.accounts ?? []}
            />
            {wasRevision ? (
              <p className="text-[12px] text-ink-2">
                {copy.REVIEW_WAS_NOTE(wasRevision)}
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="flex flex-col gap-1" data-review-now="">
        <h4 className="text-[12.5px] font-medium text-ink-2">
          {copy.REVIEW_NOW}
        </h4>
        {now !== null ? (
          <>
            <Described
              template={now.template}
              primary={now.primary}
              households={now.households}
            />
            <p className="text-[12px] text-ink-2">
              {copy.REVIEW_NOW_NOTE(now.at)}
            </p>
          </>
        ) : status.kind === "offline" ? (
          <p className="text-[13px] text-ink-1">
            {copy.REVIEW_NOW_NEEDS_CONNECTION}
          </p>
        ) : status.kind === "failed" ? (
          <Banner
            message={copy.REVIEW_NOW_FAILED}
            action={<Button onClick={onRetry}>{copy.TRY_AGAIN}</Button>}
          />
        ) : (
          <p className="text-[13px] text-ink-2">{copy.REVIEW_NOW_LOADING}</p>
        )}
      </div>
    </section>
  );
}

function Described({
  template,
  primary,
  households,
  accounts = [],
}: {
  template: DefaultTemplate;
  primary: string | null;
  households: ReadonlyArray<SnapshotHousehold | CapturedHousehold>;
  /** Names captured with the draft for the accounts the template names directly ("Was" only). */
  accounts?: readonly CapturedAccount[];
}) {
  const described = describeTemplate(template, primary, households);
  // Names only from THIS side's own snapshot (captured for "Was", current for "Now"): never today's names on the old audience.
  const labels = memberLabels(households);
  for (const account of accounts)
    if (!labels.has(account.account_id))
      labels.set(account.account_id, account.username);
  const label = (id: string) => labels.get(id) ?? anonymousLabel(id);
  const rows =
    described.households.length +
    described.accounts.length +
    described.excluded.length;
  return (
    <div className="flex flex-col gap-1 text-[13px] text-ink-1">
      <p>{described.summary}</p>
      {rows > 0 ? (
        <List className="flex flex-col gap-0.5">
          {described.households.map((household) => (
            <li
              key={`household:${household.id}`}
              className="list-none text-[12.5px]"
              data-review-household={household.id}
            >
              {"unavailable" in household
                ? copy.REVIEW_HOUSEHOLD_ACCESS(
                    copy.HOUSEHOLD_UNKNOWN,
                    household.edit,
                    copy.REVIEW_MEMBERS_UNKNOWN,
                  )
                : copy.REVIEW_HOUSEHOLD_ACCESS(
                    household.name,
                    household.edit,
                    household.members.length === 0
                      ? copy.REVIEW_HOUSEHOLD_NO_MEMBERS
                      : household.members.map((m) => m.username).join(", "),
                  )}
            </li>
          ))}
          {described.accounts.map((account) => (
            <li
              key={`account:${account.id}`}
              className="list-none text-[12.5px]"
              data-review-account={account.id}
              data-review-access={account.edit ? "edit" : "read"}
            >
              {copy.REVIEW_ACCOUNT_ACCESS(label(account.id), account.edit)}
            </li>
          ))}
          {described.excluded.map((id) => (
            <li
              key={`excluded:${id}`}
              className="list-none text-[12.5px]"
              data-review-excluded={id}
            >
              {copy.REVIEW_EXCLUDED(label(id))}
            </li>
          ))}
        </List>
      ) : null}
    </div>
  );
}
