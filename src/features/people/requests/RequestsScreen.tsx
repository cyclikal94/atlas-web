import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { useMemoryRevision } from "../memory";
import {
  cancelBody,
  type IncomingRequest,
  respondBody,
  type SentRequest,
  timeLeft,
} from "../model/requests";
import { Avatar, Banner } from "../parts";
import { readLinkage } from "../reads";
import { releaseSummary } from "../summaries";
import { timeOf } from "../summary-notes";
import {
  blockedReason,
  commonFailure,
  reportOutcome,
  reportUnder,
  retainedKeys,
  retainedUnder,
  runCommand,
} from "./commands";
import * as copy from "./copy";
import {
  answerRequest,
  RESPOND_PREFIX,
  respondFailure,
  respondKey,
  retainedAnswer,
  timeLeftText,
} from "./MergeDialog";
import { NewRequest } from "./NewRequest";
import {
  currentOf,
  forgetRefusal,
  INCOMING_KEY,
  sentKey,
  useIncoming,
  useSentPage,
} from "./reads";
import { useSenderName } from "./sender";

/**
 * WF-PEOPLE-06, `/people/requests` (§4.2–§4.5): "Waiting for you" (the incoming requests, server-backed), "Sent" (the server-backed history
 * of every state, Q16, paged) and "New request" ("Ask to link" / "Ask to merge"). From 1280 px the lists and the New request panel are
 * two columns; below, "For you · N" and "Sent" are tabs (arrow keys move between them) and "New request" opens the panel as a sheet.
 *
 * Everything shown is online, identity-bound display data (`reads.ts`): offline it is unavailable, never an old answer, and the page says
 * when it was checked (there is no push) with Refresh.
 */
type Tab = "incoming" | "sent";
const TAB_KEY = "requests-tab";

export function RequestsScreen() {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const mode = useLayoutMode();
  const incoming = useIncoming(env);
  const shownIncoming =
    currentOf(incoming) ??
    (incoming.status === "loading" ? incoming.previous : null);
  const count = shownIncoming?.value.ok
    ? shownIncoming.value.value.length
    : null;
  const tab = (env.memory.drafts.get(TAB_KEY) as Tab | undefined) ?? "incoming";
  const setTab = (next: Tab) => {
    env.memory.drafts.set(TAB_KEY, next);
    env.memory.touch();
  };
  const [panel, setPanel] = useState(false);
  const ids = { incoming: useId(), sent: useId() };
  const back = (
    <Link
      to="/people"
      className="atlas-transition inline-flex min-h-11 w-fit items-center gap-1.5 text-[13.5px] text-ink-2 hover:text-ink-1"
    >
      <ArrowLeft aria-hidden="true" size={16} />
      {copy.BACK_TO_PEOPLE}
    </Link>
  );
  const checked =
    shownIncoming !== null ? (
      <p
        className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2"
        data-requests-checked=""
      >
        {copy.CHECKED_AT(timeOf(shownIncoming.checkedAt))}
        {env.online ? (
          <Button
            variant="quiet"
            data-people-action="refresh-requests"
            onClick={() => env.memory.invalidateSummaries()}
          >
            {copy.REFRESH}
          </Button>
        ) : null}
      </p>
    ) : null;
  if (mode === "desktop")
    return (
      <div className="flex flex-col gap-5" data-requests-page="">
        {back}
        <PageHeading>{copy.REQUESTS}</PageHeading>
        <div
          className="grid gap-6"
          style={{ gridTemplateColumns: "minmax(0, 1fr) 380px" }}
        >
          <div className="flex min-w-0 flex-col gap-6">
            <section
              aria-labelledby={ids.incoming}
              className="flex flex-col gap-3"
            >
              <h2
                id={ids.incoming}
                className="text-[15px] font-medium text-ink-1"
              >
                {copy.WAITING_FOR_YOU}
                {count !== null ? (
                  <span className="font-num text-ink-2"> {count}</span>
                ) : null}
              </h2>
              {checked}
              <Incoming env={env} view={incoming} />
            </section>
            <section aria-labelledby={ids.sent} className="flex flex-col gap-3">
              <h2 id={ids.sent} className="text-[15px] font-medium text-ink-1">
                {copy.SENT}
              </h2>
              <Sent env={env} />
            </section>
          </div>
          <NewRequest />
        </div>
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-requests-page="">
      {back}
      <PageHeading>{copy.REQUESTS}</PageHeading>
      <Tabs
        tab={tab}
        onChange={setTab}
        ids={ids}
        labels={{ incoming: copy.FOR_YOU(count), sent: copy.SENT }}
      />
      <div
        role="tabpanel"
        id={`${ids[tab]}-panel`}
        aria-labelledby={`${ids[tab]}-tab`}
        className="flex flex-col gap-3"
      >
        {tab === "incoming" ? (
          <>
            {checked}
            <Incoming env={env} view={incoming} />
          </>
        ) : (
          <Sent env={env} />
        )}
      </div>
      <Button
        variant="primary"
        data-people-action="new-request"
        onClick={() => setPanel(true)}
      >
        {copy.NEW_REQUEST}
      </Button>
      <Dialog
        open={panel}
        title={copy.NEW_REQUEST}
        onClose={() => setPanel(false)}
      >
        <NewRequest bare />
      </Dialog>
    </div>
  );
}

function Tabs({
  tab,
  onChange,
  ids,
  labels,
}: {
  tab: Tab;
  onChange(tab: Tab): void;
  ids: Record<Tab, string>;
  labels: Record<Tab, string>;
}) {
  const order: Tab[] = ["incoming", "sent"];
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const move = (event: KeyboardEvent, current: Tab) => {
    const index = order.indexOf(current);
    let next: Tab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = order[(index + 1) % order.length] as Tab;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = order[(index + order.length - 1) % order.length] as Tab;
    else if (event.key === "Home") next = "incoming";
    else if (event.key === "End") next = "sent";
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={copy.REQUESTS}
      className="flex flex-wrap gap-1 border-b border-hairline"
    >
      {order.map((id) => (
        <button
          key={id}
          ref={(element) => {
            refs.current[id] = element;
          }}
          type="button"
          role="tab"
          id={`${ids[id]}-tab`}
          aria-selected={tab === id}
          aria-controls={`${ids[id]}-panel`}
          tabIndex={tab === id ? 0 : -1}
          data-tab={id}
          onClick={() => onChange(id)}
          onKeyDown={(event) => move(event, id)}
          className={`atlas-transition min-h-11 border-b-2 px-3 text-[13.5px] ${
            tab === id
              ? "border-action-ink font-medium text-ink-1"
              : "border-transparent text-ink-2 hover:text-ink-1"
          }`}
        >
          {labels[id]}
        </button>
      ))}
    </div>
  );
}

// ---- Waiting for you ---------------------------------------------------------------------------------------------------------------
function Incoming({
  env,
  view,
}: {
  env: PeopleEnv;
  view: ReturnType<typeof useIncoming>;
}) {
  const shown =
    currentOf(view) ?? (view.status === "loading" ? view.previous : null);
  const rows = shown?.value.ok
    ? [...shown.value.value].sort(
        (a, b) => a.expires_at - b.expires_at || (a.id < b.id ? -1 : 1),
      )
    : null;
  // Answers whose rows are gone (answered elsewhere, expired, or an uncertain answer that committed): every report, until dismissed, and
  // every RETAINED attempt, until a definite answer ends it (R4 of review 1: the attempt, not its report, keeps it reachable).
  const listed = new Set(rows?.map((row) => row.id) ?? []);
  const orphans = [
    ...new Set([
      ...env.memory.requestReports.keys(),
      ...retainedKeys(env, RESPOND_PREFIX),
    ]),
  ].filter(
    (key) =>
      key.startsWith(RESPOND_PREFIX) &&
      !listed.has(key.slice(RESPOND_PREFIX.length)),
  );
  return (
    <div className="flex flex-col gap-2" data-requests-incoming={view.status}>
      {orphans.map((key) => (
        <OrphanReport key={key} env={env} reportKey={key} />
      ))}
      {view.status === "offline" ? (
        <p className="text-[13.5px] text-ink-1" data-requests-state="offline">
          {copy.REQUESTS_OFFLINE}
        </p>
      ) : view.status === "failed" ? (
        <Banner
          message={copy.REQUESTS_FAILED}
          action={
            <Button
              onClick={() => {
                forgetRefusal(env, INCOMING_KEY);
                view.retry();
              }}
            >
              {copy.TRY_AGAIN}
            </Button>
          }
        />
      ) : rows === null ? (
        <p className="text-[13.5px] text-ink-2" data-requests-state="loading">
          {copy.REQUESTS_CHECKING}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-[13.5px] text-ink-1" data-requests-state="empty">
          {copy.NO_REQUESTS}
        </p>
      ) : (
        <List className="flex flex-col gap-2">
          {rows.map((request) => (
            <IncomingRow key={request.id} env={env} request={request} />
          ))}
        </List>
      )}
    </div>
  );
}

/**
 * What an answer said whose request is no longer listed (answered or withdrawn since; an uncertain answer that committed is no longer
 * pending either): kept above the list with its reference until closed. An UNCERTAIN answer is still tried again from here, exactly as it
 * was sent (its original receipt if it committed, a definite refusal otherwise), so the person learns what happened.
 */
function OrphanReport({
  env,
  reportKey,
}: {
  env: PeopleEnv;
  reportKey: string;
}) {
  const announcer = useAnnouncer();
  const report = reportUnder(env, reportKey);
  const retained = retainedUnder(env, reportKey);
  const blocked = blockedReason(env, reportKey);
  const replay = async () => {
    // A retained attempt is the only thing this key sends (`runCommand` replays it); nothing new is prepared.
    const result = await runCommand(env, reportKey, () => null);
    if (result === null) return;
    if (result.ok) {
      env.memory.requestReports.delete(reportKey);
      env.memory.touch();
      announcer.announce(copy.ANSWER_RECORDED, "polite");
      return;
    }
    reportOutcome(env, reportKey, result, commonFailure);
  };
  return (
    <Banner
      message={report?.text ?? copy.UNCERTAIN}
      requestId={report?.requestId}
      action={
        <span className="flex flex-wrap gap-2">
          {retained ? (
            blocked === null ? (
              <Button
                data-people-action="retry-answer"
                onClick={() => void replay()}
              >
                {copy.TRY_AGAIN}
              </Button>
            ) : (
              <Button disabled reason={blocked}>
                {copy.TRY_AGAIN}
              </Button>
            )
          ) : (
            // Closed only once nothing is left to resolve: closing never hides an attempt whose outcome is still unknown.
            <Button
              variant="quiet"
              onClick={() => {
                env.memory.requestReports.delete(reportKey);
                env.memory.touch();
              }}
            >
              {copy.CLOSE}
            </Button>
          )}
        </span>
      }
    />
  );
}

const acceptingKey = (id: string): string => `accepting:${id}`;

function IncomingRow({
  env,
  request,
}: {
  env: PeopleEnv;
  request: IncomingRequest;
}) {
  const announcer = useAnnouncer();
  const sender = useSenderName(env, request.sender_id);
  const senderText = sender ?? copy.SOMEONE;
  const key = respondKey(request.id);
  const report = reportUnder(env, key);
  // The answer an uncertain attempt kept for this request carried (null: none): its Try again sends THAT answer (R4 of review 1), and it is
  // offered on that answer's own action.
  const kept = retainedAnswer(env, key);
  const blocked = blockedReason(env, key);
  const proposal = request.proposal;
  // "Accept" on a link only reveals the consequence and "Confirm accept" (nothing is sent by it); kept across a remount.
  const accepting = env.memory.drafts.get(acceptingKey(request.id)) === true;
  const setAccepting = (value: boolean) => {
    if (value) env.memory.drafts.set(acceptingKey(request.id), true);
    else env.memory.drafts.delete(acceptingKey(request.id));
    env.memory.touch();
  };
  const left = timeLeftText(timeLeft(request.expires_at, env.now()));
  const answer = async (accept: boolean) => {
    const result = await answerRequest(env, request.id, accept, () =>
      respondBody({ requestId: request.id, accept }),
    );
    if (result === null) return;
    if (proposal.kind === "link")
      readLinkage(env, proposal.person_id, { force: true });
    if (result.ok) {
      env.memory.drafts.delete(acceptingKey(request.id));
      announcer.announce(
        accept && proposal.kind === "link"
          ? copy.LINKED(proposal.name)
          : accept
            ? copy.MERGE_ACCEPTED
            : copy.DECLINED,
        "polite",
      );
      return;
    }
    reportOutcome(env, key, result, (failure) =>
      respondFailure(failure, proposal.kind, senderText),
    );
  };
  const actions = (accept: "accept" | "confirm") => (
    <span className="flex flex-wrap gap-2">
      {blocked === null ? (
        <Button
          data-people-action="decline-request"
          onClick={() => void answer(false)}
        >
          {kept === false ? copy.TRY_AGAIN : copy.DECLINE}
        </Button>
      ) : (
        <Button disabled reason={blocked}>
          {copy.DECLINE}
        </Button>
      )}
      {proposal.kind === "merge" ? (
        <Link
          to="/people/requests/$requestId"
          params={{ requestId: request.id }}
          data-people-action="see-what-changes"
          className="atlas-transition inline-flex min-h-11 items-center gap-2 rounded-control bg-action-fill px-4 text-[13.5px] font-medium text-action-on hover:bg-action-hover"
        >
          {copy.SEE_WHAT_CHANGES}
        </Link>
      ) : accept === "accept" && kept !== true ? (
        <Button
          variant="primary"
          data-people-action="accept-request"
          onClick={() => setAccepting(true)}
        >
          {copy.ACCEPT}
        </Button>
      ) : blocked === null ? (
        <Button
          variant="primary"
          data-people-action="confirm-accept"
          onClick={() => void answer(true)}
        >
          {kept === true ? copy.TRY_AGAIN : copy.CONFIRM_ACCEPT}
        </Button>
      ) : (
        <Button variant="primary" disabled reason={blocked}>
          {copy.CONFIRM_ACCEPT}
        </Button>
      )}
    </span>
  );
  return (
    <li
      className="flex list-none flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3"
      data-incoming-request={request.id}
      data-request-kind={proposal.kind}
    >
      <div className="flex items-center gap-3">
        <Avatar name={senderText} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] text-ink-1">
            <span
              className="font-medium"
              data-request-sender={sender === null ? "unknown" : "known"}
            >
              {senderText}
            </span>{" "}
            {proposal.kind === "link"
              ? copy.WANTS_TO_LINK(proposal.name)
              : copy.WANTS_TO_MERGE}
          </span>
          <span className="text-[12.5px] text-ink-2" data-request-left="">
            {left}
          </span>
        </span>
      </div>
      {sender === null ? (
        <p className="text-[12.5px] text-ink-2" data-request-caution="">
          {copy.UNNAMED_CAUTION}
        </p>
      ) : null}
      {proposal.kind === "link" && (accepting || kept === true) ? (
        <div
          className="flex flex-col gap-2 rounded-row border border-hairline bg-canvas p-3"
          data-link-consequence=""
        >
          <p className="text-[13px] font-medium text-ink-1">
            {copy.BEFORE_YOU_ACCEPT}
          </p>
          <p className="text-[13px] leading-[1.6] text-ink-1">
            {copy.LINK_CONSEQUENCE(proposal.name)}
          </p>
          {actions("confirm")}
        </div>
      ) : (
        actions("accept")
      )}
      {report !== null ? (
        <Banner message={report.text} requestId={report.requestId} />
      ) : null}
    </li>
  );
}

// ---- Sent ------------------------------------------------------------------------------------------------------------------------
const CURSORS_KEY = "requests-sent-cursors";

function Sent({ env }: { env: PeopleEnv }) {
  // The cursors of the pages before this one (WEB-11a's list pattern): Previous restores the page it came from. Kept across a remount.
  const cursors = (env.memory.drafts.get(CURSORS_KEY) as
    | (string | null)[]
    | undefined) ?? [null];
  const after = cursors.at(-1) ?? null;
  // DA-N1 of review 2: the history keeps ONE page (Q9 allows three): moving to another page lets go of this one (a page read before is
  // read again; only the cursors are kept, across a remount too).
  const setCursors = (next: (string | null)[]) => {
    releaseSummary(env.memory, sentKey(after));
    env.memory.drafts.set(CURSORS_KEY, next);
    env.memory.touch();
  };
  const view = useSentPage(env, after);
  const shown =
    currentOf(view) ?? (view.status === "loading" ? view.previous : null);
  const page = shown?.value.ok ? shown.value.value : null;
  const first = cursors.length === 1;
  return (
    <div className="flex flex-col gap-2" data-requests-sent={view.status}>
      {view.status === "offline" ? (
        <p className="text-[13.5px] text-ink-1" data-sent-state="offline">
          {copy.REQUESTS_OFFLINE}
        </p>
      ) : view.status === "failed" ? (
        <Banner
          message={copy.REQUESTS_FAILED}
          action={
            <Button
              onClick={() => {
                forgetRefusal(env, sentKey(after));
                view.retry();
              }}
            >
              {copy.TRY_AGAIN}
            </Button>
          }
        />
      ) : page === null ? (
        <p className="text-[13.5px] text-ink-2" data-sent-state="loading">
          {copy.REQUESTS_CHECKING}
        </p>
      ) : page.items.length === 0 ? (
        <p
          className="text-[13.5px] text-ink-1"
          data-sent-state={page.next_after === null && first ? "empty" : "more"}
        >
          {page.next_after === null && first ? copy.NO_SENT : copy.PAGE_MORE}
        </p>
      ) : (
        <List className="flex flex-col gap-2">
          {page.items.map((request) => (
            <SentRow key={request.id} env={env} request={request} />
          ))}
        </List>
      )}
      {page !== null && (!first || page.next_after !== null) ? (
        <span className="flex flex-wrap gap-2">
          {!first ? (
            <Button
              data-people-action="sent-previous"
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              {copy.PREVIOUS}
            </Button>
          ) : null}
          {page.next_after !== null ? (
            <Button
              data-people-action="sent-next"
              onClick={() => setCursors([...cursors, page.next_after])}
            >
              {copy.NEXT}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export const cancelKey = (id: string): string => `cancel:${id}`;

function SentRow({ env, request }: { env: PeopleEnv; request: SentRequest }) {
  const announcer = useAnnouncer();
  const key = cancelKey(request.id);
  const report = reportUnder(env, key);
  const retained = retainedUnder(env, key);
  const blocked = blockedReason(env, key);
  const proposal = request.proposal;
  const text =
    proposal.kind === "link"
      ? copy.SENT_LINK(request.recipient_username, proposal.name)
      : copy.SENT_MERGE(request.recipient_username, proposal.name);
  const cancel = async () => {
    const result = await runCommand(env, key, () =>
      cancelBody({ requestId: request.id }),
    );
    if (result === null) return;
    if (result.ok) {
      announcer.announce(copy.CANCELLED, "polite");
      return;
    }
    reportOutcome(env, key, result, (failure) =>
      failure.kind === "not_found"
        ? copy.ANSWERED_ELSEWHERE
        : commonFailure(failure),
    );
  };
  const action =
    blocked === null ? (
      <Button
        variant="quiet"
        data-people-action="cancel-request"
        aria-label={copy.CANCEL_REQUEST_TO(request.recipient_username)}
        onClick={() => void cancel()}
      >
        {retained ? copy.TRY_AGAIN : copy.CANCEL_REQUEST}
      </Button>
    ) : (
      <Button variant="quiet" disabled reason={blocked}>
        {retained ? copy.TRY_AGAIN : copy.CANCEL_REQUEST}
      </Button>
    );
  return (
    <li
      className="flex list-none flex-col gap-2 rounded-row border border-hairline-strong bg-panel p-3"
      data-sent-request={request.id}
      data-sent-state={request.state}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 text-[13.5px] text-ink-1">{text}</span>
        {request.state === "pending" ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-ink-2">
              {timeLeftText(timeLeft(request.expires_at, env.now()))}
            </span>
            {action}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span
              className="text-[12.5px] font-medium text-ink-2"
              data-sent-label=""
            >
              {copy.STATE[request.state]}
            </span>
            {/* A retained uncertain cancel stays reachable whatever the row says now (R4 of review 1): a cancel that committed is no
                longer pending, and only its Try again learns its answer. */}
            {retained ? action : null}
          </span>
        )}
      </div>
      {report !== null ? (
        <Banner message={report.text} requestId={report.requestId} />
      ) : null}
    </li>
  );
}
