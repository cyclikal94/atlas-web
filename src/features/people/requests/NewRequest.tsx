import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useAnnouncer } from "../../../components/ui/announcer";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { List } from "../../../components/ui/list";
import { untilSent } from "../../sharing";
import { DirectoryLookup } from "../../sharing/DirectoryLookup";
import type { PeopleResult } from "../api";
import { type PeopleEnv, usePeopleEnv } from "../env";
import { isCurrentMemory, useMemoryRevision } from "../memory";
import { requestLinkBody } from "../model/requests";
import type { PersonSummary, SummaryScope } from "../model/summary";
import { Avatar, Banner } from "../parts";
import { linkageIn, readLinkage, usePersonLinkage } from "../reads";
import { useOwnedSummary, type WalkedPages, walkPages } from "../summaries";
import {
  blockedReason,
  commonFailure,
  originOf,
  type Receipt,
  reportOutcome,
  reportUnder,
  retainedKeys,
  retainedUnder,
  runCommandFrom,
  sendingUnder,
} from "./commands";
import * as copy from "./copy";

/**
 * "New request" (§4.5): two genuinely different forms, "Ask to link" (a person and a recipient) and "Ask to merge" (two people; Atlas
 * works out who has to agree). Their input is kept in page memory (`NEW_REQUEST_KEY`), so it outlives a remount of the protected tree and
 * switching between the two forms (PRODUCT-DECISIONS-20261011 item 2: a hidden form's values are kept, and restored when it is shown); a
 * send uses only the form shown, says nothing about the other, and clears only what it sent, never input typed after it was captured.
 *
 * Commands are online-only (§4.7): offline or read-only the forms stay editable and their action says why it cannot send.
 */
export interface NewRequestDraft {
  mode: "link" | "merge";
  link: {
    person: { id: string; label: string } | null;
    recipient: { id: string; username: string } | null;
  };
  merge: {
    first: { id: string; label: string } | null;
    second: { id: string; label: string } | null;
  };
  /** Bumped by every change of the link form: a send that completes for an earlier revision keeps the later input. */
  revision: number;
}
export const NEW_REQUEST_KEY = "new-request";
export const emptyDraft = (): NewRequestDraft => ({
  mode: "link",
  link: { person: null, recipient: null },
  merge: { first: null, second: null },
  revision: 0,
});
export const requestLinkKey = (personId: string): string =>
  `request-link:${personId}`;

export function draftOf(env: PeopleEnv): NewRequestDraft {
  return (
    (env.memory.drafts.get(NEW_REQUEST_KEY) as NewRequestDraft | undefined) ??
    emptyDraft()
  );
}

function useDraft(
  env: PeopleEnv,
): [
  NewRequestDraft,
  (change: (draft: NewRequestDraft) => NewRequestDraft) => void,
] {
  const draft = draftOf(env);
  const update = (change: (draft: NewRequestDraft) => NewRequestDraft) => {
    env.memory.drafts.set(NEW_REQUEST_KEY, change(draftOf(env)));
    env.memory.touch();
  };
  return [draft, update];
}

export function NewRequest({ bare = false }: { bare?: boolean }) {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const [draft, update] = useDraft(env);
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-new-request={draft.mode}
      className={
        bare
          ? "flex flex-col gap-4"
          : "flex flex-col gap-4 rounded-row border border-hairline-strong bg-panel p-3.5"
      }
    >
      <h2
        id={heading}
        className={bare ? "sr-only" : "text-[15px] font-medium text-ink-1"}
      >
        {copy.NEW_REQUEST}
      </h2>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{copy.NEW_REQUEST}</legend>
        {(["link", "merge"] as const).map((mode) => (
          <Button
            key={mode}
            variant={draft.mode === mode ? "primary" : "secondary"}
            aria-pressed={draft.mode === mode}
            data-request-mode={mode}
            onClick={() => update((d) => ({ ...d, mode }))}
          >
            {mode === "link" ? copy.ASK_TO_LINK : copy.ASK_TO_MERGE}
          </Button>
        ))}
      </fieldset>
      {draft.mode === "link" ? <AskToLink /> : <AskToMerge />}
    </section>
  );
}

// ---- Ask to link -------------------------------------------------------------------------------------------------------------------
/** What an Ask to link send was made of: the form's revision at the press, and the person and recipient it was addressed to. */
interface LinkOrigin {
  revision: number;
  person: { id: string; label: string };
  recipient: { id: string; username: string };
}
const LINK_PREFIX = "request-link:";
type LinkSent = {
  result: PeopleResult<Receipt>;
  origin: LinkOrigin | null;
} | null;

/**
 * What a link request's answer does, for the attempt it answers (R1 of review 1): a success names the recipient THAT attempt was addressed
 * to and clears the form only when nothing was typed after that attempt was captured; anything else is said under its key.
 */
function completeLink(
  env: PeopleEnv,
  key: string,
  sent: LinkSent,
  announce: (text: string) => void,
): void {
  if (sent === null) return;
  const { result, origin } = sent;
  readLinkage(env, key.slice(LINK_PREFIX.length), { force: true });
  if (result.ok) {
    if (origin === null) return;
    announce(copy.REQUEST_SENT(origin.recipient.username));
    // Cleared only when nothing was typed after the capture (a newer edit stays).
    const draft = draftOf(env);
    if (draft.revision === origin.revision) {
      env.memory.drafts.set(NEW_REQUEST_KEY, {
        ...draft,
        link: { person: null, recipient: null },
      });
      env.memory.touch();
    }
    return;
  }
  reportOutcome(env, key, result, (failure) =>
    failure.kind === "capacity"
      ? copy.CAPACITY(origin?.recipient.username ?? copy.THE_OTHER_OWNER)
      : failure.kind === "conflict"
        ? copy.PERSON_CHANGED
        : failure.kind === "not_found"
          ? copy.PREVIEW_NOT_FOUND
          : commonFailure(failure),
  );
}

/**
 * An uncertain link request kept for a person the form no longer shows (the person was changed after it): still said, with Try again,
 * which sends it again exactly as it was. It ends only with a definite answer, never by editing the form.
 */
function EarlierLink({
  attemptKey,
  onSent,
}: {
  attemptKey: string;
  onSent(sent: LinkSent): void;
}) {
  const env = usePeopleEnv();
  const origin = originOf<LinkOrigin>(env, attemptKey);
  const report = reportUnder(env, attemptKey);
  const blocked = blockedReason(env, attemptKey);
  return (
    <div
      className="flex flex-col gap-1"
      data-earlier-link={attemptKey.slice(LINK_PREFIX.length)}
    >
      <Banner
        message={report?.text ?? copy.UNCERTAIN}
        requestId={report?.requestId}
        action={
          blocked === null ? (
            <Button
              data-people-action="retry-earlier-link"
              onClick={() =>
                void runCommandFrom<LinkOrigin>(
                  env,
                  attemptKey,
                  () => null,
                ).then(onSent)
              }
            >
              {copy.TRY_AGAIN}
            </Button>
          ) : (
            <Button disabled reason={blocked}>
              {copy.TRY_AGAIN}
            </Button>
          )
        }
      />
      {origin !== null ? (
        <p className="text-[12.5px] text-ink-2">
          {copy.EARLIER_LINK(origin.person.label, origin.recipient.username)}
        </p>
      ) : null}
    </div>
  );
}

function AskToLink() {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const announcer = useAnnouncer();
  const announce = (text: string) => announcer.announce(text, "polite");
  const [draft, update] = useDraft(env);
  const [view, setView] = useState<"form" | "person" | "lookup">("form");
  const person = draft.link.person;
  const recipient = draft.link.recipient;
  const linkage = usePersonLinkage(person?.id ?? null).linkage;
  const setLink = (link: Partial<NewRequestDraft["link"]>) =>
    update((d) => ({
      ...d,
      link: { ...d.link, ...link },
      revision: d.revision + 1,
    }));
  const key = person ? requestLinkKey(person.id) : null;
  const report = key ? reportUnder(env, key) : null;
  const retained = key ? retainedUnder(env, key) : false;

  if (view === "lookup")
    return (
      <DirectoryLookup
        purpose={copy.WHO_TO_ASK}
        onBack={() => setView("form")}
        onChoose={(entry) => {
          setLink({ recipient: { id: entry.id, username: entry.username } });
          setView("form");
        }}
      />
    );
  if (view === "person")
    return (
      <PersonPicker
        label={copy.WHICH_OF_YOUR_PEOPLE}
        scope="not_linked"
        purpose="link"
        offer={(summary) =>
          summary.your_access === "owner" &&
          !summary.archived &&
          summary.linkage === "none"
        }
        empty={copy.NO_PEOPLE_TO_OFFER}
        onBack={() => setView("form")}
        onChoose={(summary) => {
          setLink({ person: { id: summary.id, label: summary.label } });
          setView("form");
        }}
      />
    );

  const send = async () => {
    if (person === null || recipient === null || key === null) return;
    // The input this send is made of, captured at the press: only it is cleared by a success (later edits stay). A retained attempt is
    // sent again as it was, and completes with ITS origin (the recipient it was addressed to, the input it was made of).
    const capture: LinkOrigin = {
      revision: draftOf(env).revision,
      person,
      recipient,
    };
    const memory = env.memory;
    const sent = await runCommandFrom<LinkOrigin>(env, key, async () => {
      // Who controls the person, judged AT THE PRESS: only a known unlinked person is offered, at the version that answer read.
      const now = linkageIn(env, person.id);
      if (!now.known || now.kind !== "unlinked") return null;
      // The recipient is checked again with the exact lookup immediately before sending (D-11b-11): an unknown account would be
      // answered `401`, which signs the reader out of what is shown (§6 R2, E-2a).
      const verified = await untilSent(
        () => env.sharing.lookup(recipient.username),
        {
          isCurrent: () => isCurrentMemory(memory),
        },
      );
      if (!isCurrentMemory(memory)) return null;
      if (!verified.ok) {
        memory.requestReports.set(key, {
          text: copy.LOOKUP_FAILED,
          ...("requestId" in verified && verified.requestId
            ? { requestId: verified.requestId }
            : {}),
        });
        memory.touch();
        return null;
      }
      const same = verified.value.filter(
        (entry) => entry.username === recipient.username,
      );
      if (same.length !== 1 || same[0]?.id !== recipient.id) {
        memory.requestReports.set(key, { text: copy.ACCOUNT_GONE });
        memory.touch();
        return null;
      }
      return {
        body: requestLinkBody({
          requestId: env.newId(),
          personId: person.id,
          accountId: recipient.id,
          version: now.version,
        }),
        origin: capture,
      };
    });
    completeLink(env, key, sent, announce);
  };

  const sending = key !== null && sendingUnder(env, key);
  // What Try again sends when an attempt is kept: the EARLIER request, as it was (said when the form now names someone else).
  const origin = key !== null ? originOf<LinkOrigin>(env, key) : null;
  const sendsEarlier =
    retained && origin !== null && origin.recipient.id !== recipient?.id;
  // Uncertain requests for OTHER people of this form (the person was changed since): each stays reachable here.
  const others = retainedKeys(env, LINK_PREFIX).filter(
    (other) => other !== key,
  );
  const reason =
    person === null
      ? copy.CHOOSE_PERSON_FIRST
      : recipient === null
        ? copy.CHOOSE_RECIPIENT_FIRST
        : (blockedReason(env, key as string) ??
          (sending
            ? copy.SAVING
            : retained
              ? null
              : !linkage.known
                ? copy.CHECK_LINK_FIRST
                : linkage.kind !== "unlinked"
                  ? copy.ALREADY_LINKED
                  : null));
  return (
    <div className="flex flex-col gap-4" data-ask-to-link="">
      {others.map((other) => (
        <EarlierLink
          key={other}
          attemptKey={other}
          onSent={(sent) => completeLink(env, other, sent, announce)}
        />
      ))}
      <p className="text-[13px] leading-[1.6] text-ink-2">{copy.LINK_INTRO}</p>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-1">
          {copy.WHICH_OF_YOUR_PEOPLE}
        </span>
        {person !== null ? (
          <span
            className="flex items-center gap-2"
            data-link-person={person.id}
          >
            <Avatar name={person.label} />
            <span className="text-[13.5px] text-ink-1">{person.label}</span>
            <Button
              variant="quiet"
              data-people-action="change-person"
              onClick={() => setView("person")}
            >
              {copy.CHANGE}
            </Button>
          </span>
        ) : (
          <Button
            data-people-action="choose-person"
            onClick={() => setView("person")}
          >
            {copy.CHOOSE}
          </Button>
        )}
        <span className="text-[12px] text-ink-2">{copy.ONLY_UNLINKED}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-1">
          {copy.WHO_TO_ASK}
        </span>
        {recipient !== null ? (
          <span
            className="flex items-center gap-2"
            data-link-recipient={recipient.username}
          >
            <Avatar name={recipient.username} />
            <span className="text-[13.5px] text-ink-1">
              {recipient.username}
            </span>
            <Button
              variant="quiet"
              data-people-action="change-recipient"
              onClick={() => setView("lookup")}
            >
              {copy.CHANGE}
            </Button>
          </span>
        ) : (
          <Button
            data-people-action="search-directory"
            onClick={() => setView("lookup")}
          >
            {copy.SEARCH_DIRECTORY}
          </Button>
        )}
      </div>
      {report !== null ? (
        <Banner message={report.text} requestId={report.requestId} />
      ) : null}
      <span className="flex flex-col items-start gap-1">
        {sendsEarlier ? (
          <span className="text-[12.5px] text-ink-2" data-retry-sends="">
            {copy.RETRY_SENDS_EARLIER(origin.recipient.username)}
          </span>
        ) : null}
        {reason === null ? (
          <Button
            variant="primary"
            data-people-action="send-link-request"
            onClick={() => void send()}
          >
            {retained ? copy.TRY_AGAIN : copy.SEND_REQUEST}
          </Button>
        ) : (
          <Button variant="primary" disabled reason={reason}>
            {copy.SEND_REQUEST}
          </Button>
        )}
        <span className="text-[12px] text-ink-2">{copy.REQUEST_RULES}</span>
      </span>
    </div>
  );
}

// ---- Ask to merge ------------------------------------------------------------------------------------------------------------------
function AskToMerge() {
  const env = usePeopleEnv();
  useMemoryRevision(env.memory);
  const navigate = useNavigate();
  const [draft, update] = useDraft(env);
  const [view, setView] = useState<"form" | "first" | "second">("form");
  const { first, second } = draft.merge;
  const setMerge = (merge: Partial<NewRequestDraft["merge"]>) =>
    update((d) => ({ ...d, merge: { ...d.merge, ...merge } }));
  if (view !== "form")
    return (
      <PersonPicker
        label={
          view === "first" ? copy.ONE_OF_YOUR_PEOPLE : copy.THE_SAME_PERSON
        }
        purpose={
          view === "first" ? "merge-first" : `merge-second:${first?.id ?? ""}`
        }
        scope="all"
        offer={(summary) =>
          !summary.archived &&
          (view === "first"
            ? summary.your_access === "owner"
            : summary.id !== first?.id)
        }
        empty={copy.NO_PEOPLE_TO_OFFER}
        onBack={() => setView("form")}
        onChoose={(summary) => {
          const chosen = { id: summary.id, label: summary.label };
          if (view === "first")
            setMerge({
              first: chosen,
              ...(second?.id === summary.id ? { second: null } : {}),
            });
          else setMerge({ second: chosen });
          setView("form");
        }}
      />
    );
  const reason =
    first === null || second === null
      ? copy.CHOOSE_BOTH_FIRST
      : !env.writable
        ? copy.READ_ONLY_COMPAT
        : !env.online
          ? copy.NEEDS_CONNECTION
          : null;
  const pick = (
    which: "first" | "second",
    chosen: { id: string; label: string } | null,
    label: string,
  ) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink-1">{label}</span>
      {chosen !== null ? (
        <span className="flex items-center gap-2" data-merge-pick={which}>
          <Avatar name={chosen.label} />
          <span className="text-[13.5px] text-ink-1">{chosen.label}</span>
          <Button variant="quiet" onClick={() => setView(which)}>
            {copy.CHANGE}
          </Button>
        </span>
      ) : (
        <Button
          data-people-action={`choose-${which}`}
          onClick={() => setView(which)}
        >
          {copy.CHOOSE}
        </Button>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-4" data-ask-to-merge="">
      <p className="text-[13px] leading-[1.6] text-ink-2">{copy.MERGE_INTRO}</p>
      {pick("first", first, copy.ONE_OF_YOUR_PEOPLE)}
      {pick("second", second, copy.THE_SAME_PERSON)}
      {reason === null && first !== null && second !== null ? (
        <Button
          variant="primary"
          data-people-action="compare"
          onClick={() =>
            void navigate({
              to: "/people/requests/merge/$sourceId/$targetId",
              params: { sourceId: second.id, targetId: first.id },
            })
          }
        >
          {copy.COMPARE}
        </Button>
      ) : (
        <Button
          variant="primary"
          disabled
          reason={reason ?? copy.CHOOSE_BOTH_FIRST}
        >
          {copy.COMPARE}
        </Button>
      )}
    </div>
  );
}

// ---- choosing a person -----------------------------------------------------------------------------------------------------------
/**
 * The picker reads 100-row pages and keeps at most three of them (Q9's retained pages), and every further person stays reachable (R2 of
 * review 1: Q9's "keep further records accessible through pagination"). A WINDOW is one bounded walk from its start: "Show more" reads its
 * next page while it has fewer than three; once it has three, "Show the next people" starts a new window where it ended, and "Show earlier
 * people" goes back to the window before (read again: only the starts of the windows are kept). The filter applies to the window shown;
 * until the whole list fits in one window from its first person, the picker says so, and an empty answer is never claimed for people it
 * has not read.
 *
 * RETAINED (R2 of review 2): the picker OWNS its read (`useOwnedSummary`, keyed by this mounted picker): only the current window's walk is
 * kept, at most three pages of rows (every row it read, kept or not). A step to another window, Show more, a change of purpose and closing
 * the picker each release the earlier walk, and a page of it still on its way applies nothing and reads no further.
 */
const PICKER_PAGE = 100;
const PICKER_PAGES = 3;

function PersonPicker({
  label,
  scope,
  purpose,
  offer,
  empty,
  onChoose,
  onBack,
}: {
  label: string;
  scope: SummaryScope;
  /**
   * What the picker is for: part of its read's key, because the rows it KEEPS depend on `offer` (Ask to merge's two pickers read the same
   * scope and keep different people; one key would hand the second picker the first one's rows).
   */
  purpose: string;
  offer(summary: PersonSummary): boolean;
  empty: string;
  onChoose(summary: PersonSummary): void;
  onBack(): void;
}) {
  const env = usePeopleEnv();
  // The starts of the windows walked so far (the first is the list's beginning); the last is shown.
  const [starts, setStarts] = useState<(string | null)[]>([null]);
  const [pages, setPages] = useState(1);
  const [filter, setFilter] = useState("");
  const heading = useId();
  const owner = useId();
  const start = starts.at(-1) ?? null;
  const view = useOwnedSummary<WalkedPages<PersonSummary>>(
    `picker:${scope}:${purpose}:${owner}:${start ?? ""}:${pages}`,
    (current) =>
      walkPages(
        (after) =>
          env.api.readSummaries(scope, {
            after,
            limit: PICKER_PAGE,
            archived: false,
          }),
        // Bounded by its pages (at most 300 rows read): a limit of exactly 300 kept would stop on a window's last row before its page
        // said whether it is the end.
        { start, keep: offer, limit: PICKER_PAGE * PICKER_PAGES + 1, pages },
        current,
      ),
  );
  const shown =
    view.status === "ready"
      ? view.value
      : view.status === "loading"
        ? (view.previous?.value ?? null)
        : null;
  const needle = filter.trim().toLocaleLowerCase();
  const rows = (shown?.kept ?? []).filter(
    (summary) =>
      needle === "" || summary.label.toLocaleLowerCase().includes(needle),
  );
  // The window holds the whole list: it starts at the first person and reached the last page.
  const whole = starts.length === 1 && shown !== null && shown.end;
  const more = shown !== null && !shown.end && shown.next !== null;
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-3"
      data-person-picker={scope}
      data-picker-window={starts.length}
    >
      <div className="flex items-center gap-3">
        <Button variant="quiet" onClick={onBack}>
          ‹ {copy.CANCEL}
        </Button>
        <h3 id={heading} className="text-[15px] font-medium text-ink-1">
          {label}
        </h3>
      </div>
      <Input
        label={copy.FILTER_PEOPLE}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        autoComplete="off"
      />
      {shown !== null && !whole && needle !== "" ? (
        <p className="text-[12.5px] text-ink-2" data-picker-partial="">
          {copy.FILTER_SHOWN_ONLY}
        </p>
      ) : null}
      {view.status === "offline" ? (
        <p className="text-[13px] text-ink-2">{copy.PEOPLE_OFFLINE}</p>
      ) : view.status === "failed" ? (
        <Banner
          message={copy.PEOPLE_FAILED}
          action={<Button onClick={view.retry}>{copy.TRY_AGAIN}</Button>}
        />
      ) : shown === null ? (
        <p className="text-[13px] text-ink-2">{copy.REQUESTS_CHECKING}</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-ink-1" data-picker-empty="">
          {whole
            ? shown.kept.length === 0
              ? empty
              : copy.NO_MATCHES
            : shown.kept.length === 0
              ? copy.NONE_OFFERED_SHOWN
              : copy.NO_MATCHES_SHOWN}
        </p>
      ) : (
        <List className="flex flex-col gap-1">
          {rows.map((summary) => (
            <li key={summary.id} className="list-none">
              <button
                type="button"
                data-pick-person={summary.id}
                onClick={() => onChoose(summary)}
                className="atlas-transition flex min-h-11 w-full items-center gap-3 rounded-row px-3 py-2 text-left hover:bg-row-hover"
              >
                <Avatar name={summary.label} />
                <span className="text-[13.5px] text-ink-1">
                  {summary.label}
                </span>
              </button>
            </li>
          ))}
        </List>
      )}
      {shown !== null && (more || starts.length > 1) ? (
        <span className="flex flex-wrap gap-2">
          {starts.length > 1 ? (
            <Button
              data-people-action="picker-earlier"
              onClick={() => {
                setStarts(starts.slice(0, -1));
                setPages(PICKER_PAGES);
              }}
            >
              {copy.SHOW_EARLIER_PEOPLE}
            </Button>
          ) : null}
          {more && pages < PICKER_PAGES ? (
            <Button
              data-people-action="picker-more"
              onClick={() => setPages(pages + 1)}
            >
              {copy.SHOW_MORE}
            </Button>
          ) : more ? (
            <Button
              data-people-action="picker-next"
              onClick={() => {
                setStarts([...starts, shown.next]);
                setPages(1);
              }}
            >
              {copy.SHOW_NEXT_PEOPLE}
            </Button>
          ) : null}
        </span>
      ) : null}
    </section>
  );
}
