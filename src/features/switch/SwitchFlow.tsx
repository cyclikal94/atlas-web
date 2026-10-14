import {
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Dialog } from "../../components/ui/dialog";
import {
  listRetainedAccounts,
  type RetainedAccount,
  type RetainedListing,
  useAccountLabel,
  useQueueSummary,
} from "../../data";
import { type Session, useSession } from "../../session";
import {
  type SignInResult,
  type SsoResult,
  signIn,
  startSso,
} from "../authentication/controller";
import { authFeedback } from "../authentication/feedback";
import type { Message } from "../authentication/outcome-copy";
import { SignInForm } from "../authentication/SignInForm";
import { useOnline } from "../authentication/use-online";
import { type SwitchTarget, switchFlow } from "./state";
import {
  cautionText,
  SWITCH_COPY,
  signInAs,
  stayAs,
  waitingTag,
} from "./switch-copy";

/**
 * WF-SWITCH-01 and WF-SWITCH-02 (WEB-08c, gaps G-8 and G-20), loaded lazily by `entry.tsx` only when the person opens the switcher,
 * so none of it is in the initial chunk (D-8c-05).
 *
 * Switching is an ORDINARY sign-in (D-8c-02): the form calls the existing controller, which begins a password (or single sign-on)
 * attempt. The session kernel implements lifecycle row 7: the outgoing account renders until the incoming attempt's `activating` write,
 * "Finishing sign-in" follows, and the incoming account mounts with a NEW router at `/`. Nothing of the outgoing account is issued after
 * that write commits, its queue stays saved for it and is never sent under the incoming identity (the kernel and the outbox enforce it;
 * the lifecycle evidence shows it end to end). This module decides nothing about identity.
 *
 * Names: the current account's row uses the label VERIFIED for the current epoch (`useAccountLabel`), and a retained account's row
 * its own last verified username, presented only as "Used on this computer before" (D-8c-01). Nothing is derived from an account id.
 */
const browserNavigate = (url: string) => location.assign(url);

/** The current account's unsynced work as the queue counts it: waiting to send, plus what needs a decision before it can. */
function useCurrentWaiting(): number | null {
  const summary = useQueueSummary();
  return summary.status === "ready"
    ? summary.value.waiting + summary.value.needsDecision
    : null;
}

type Row =
  | { kind: "current" }
  | { kind: "retained"; account: RetainedAccount }
  | { kind: "other" };

export function SwitchPicker({
  owner,
  onClose,
  list = listRetainedAccounts,
}: {
  owner: string;
  onClose(): void;
  /** Test seam: the retained-account listing. */
  list?: typeof listRetainedAccounts;
}) {
  const label = useAccountLabel();
  const waiting = useCurrentWaiting();
  const [listing, setListing] = useState<RetainedListing | null>(null);
  const listId = useId();
  const noteId = useId();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the listing is read once per opening, for the account it was opened for
  useEffect(() => {
    const controller = new AbortController();
    list({ exclude: owner, signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) setListing(result);
      },
      () => {
        if (!controller.signal.aborted) setListing({ kind: "unknown" });
      },
    );
    return () => controller.abort();
  }, [owner]);

  const retained =
    listing?.kind === "ok"
      ? listing.accounts.map((account) => ({
          kind: "retained" as const,
          account,
        }))
      : [];
  const rows: Row[] = [{ kind: "current" }, ...retained, { kind: "other" }];
  const onlyOne = listing?.kind === "ok" && listing.accounts.length === 0;

  // Focus moves into the listbox when it is ready, so Up/Down work at once; the active option is announced through aria-activedescendant.
  useEffect(() => {
    if (listing !== null) listRef.current?.focus();
  }, [listing]);

  const pick = (row: Row) => {
    if (row.kind === "current") return;
    const target: SwitchTarget =
      row.kind === "other"
        ? { kind: "other" }
        : {
            kind: "retained",
            account_id: row.account.account_id,
            name: row.account.lastVerifiedName,
          };
    switchFlow.choose(owner, target);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + rows.length) % rows.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(rows.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;
  const currentName = label ?? SWITCH_COPY.thisAccount;

  return (
    <Dialog
      open
      onClose={onClose}
      title={SWITCH_COPY.title}
      initialFocusSelector="[data-switch-list], [data-switch-loading]"
      returnFocusRef={{ current: switchFlow.returnFocus() }}
    >
      <div className="flex flex-col gap-4" data-switch-picker="">
        <p
          id={noteId}
          data-switch-note=""
          className="text-[13px] leading-[1.6] text-ink-2"
        >
          {SWITCH_COPY.note}
        </p>
        {listing === null ? (
          <div
            aria-busy="true"
            data-switch-loading=""
            tabIndex={-1}
            className="flex flex-col gap-3"
          >
            <span className="sr-only">{SWITCH_COPY.loading}</span>
            {[0, 1].map((key) => (
              <span
                key={key}
                aria-hidden="true"
                className="flex items-center gap-3"
              >
                <span className="size-9 motion-safe:animate-pulse rounded-full bg-hairline-strong" />
                <span className="flex flex-col gap-1.5">
                  <span className="h-3.5 w-32 motion-safe:animate-pulse rounded-control bg-hairline-strong" />
                  <span className="h-3 w-48 motion-safe:animate-pulse rounded-control bg-hairline-strong" />
                </span>
              </span>
            ))}
          </div>
        ) : (
          <>
            {listing.kind === "unknown" ? (
              <p
                data-switch-unknown=""
                className="text-[13px] leading-[1.6] text-ink-1"
              >
                {SWITCH_COPY.unknownListing}
              </p>
            ) : null}
            {onlyOne ? (
              <p
                data-switch-only-one=""
                className="text-[13px] leading-[1.6] text-ink-1"
              >
                {SWITCH_COPY.onlyOne}
              </p>
            ) : null}
            <div
              ref={listRef}
              role="listbox"
              aria-label={SWITCH_COPY.title}
              aria-describedby={noteId}
              aria-activedescendant={optionId(active)}
              tabIndex={0}
              data-switch-list=""
              onKeyDown={onKeyDown}
              className="flex flex-col gap-1 rounded-row"
            >
              {rows.map((row, index) => {
                const selected = index === active;
                const base =
                  "flex min-h-12 cursor-pointer items-center gap-3 rounded-row px-3 py-2 text-[14px] text-ink-1 hover:bg-row-hover";
                const tone = selected ? " bg-select-tint" : "";
                if (row.kind === "current")
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard (aria-activedescendant)
                    <div
                      key="current"
                      id={optionId(index)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      aria-disabled="true"
                      data-switch-row="current"
                      className={base + tone}
                      onClick={() => setActive(index)}
                    >
                      <Avatar name={label} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="break-words">{currentName}</span>
                        <span className="text-[12.5px] text-ink-2">
                          {SWITCH_COPY.signedInNow}
                        </span>
                      </span>
                      {waiting !== null && waiting > 0 ? (
                        <span
                          data-switch-waiting=""
                          className="shrink-0 rounded-control border border-hairline-strong px-1.5 py-0.5 text-[12px] text-ink-2"
                        >
                          {waitingTag(waiting)}
                        </span>
                      ) : null}
                    </div>
                  );
                if (row.kind === "retained") {
                  const name =
                    row.account.lastVerifiedName ?? SWITCH_COPY.unnamedRetained;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard (aria-activedescendant)
                    <div
                      key={row.account.account_id}
                      id={optionId(index)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      data-switch-row="retained"
                      className={base + tone}
                      onClick={() => pick(row)}
                    >
                      <Avatar name={row.account.lastVerifiedName} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="break-words">{name}</span>
                        <span className="text-[12.5px] text-ink-2">
                          {SWITCH_COPY.usedBefore}
                        </span>
                      </span>
                      {typeof row.account.waiting === "number" &&
                      row.account.waiting > 0 ? (
                        <span className="shrink-0 rounded-control border border-hairline-strong px-1.5 py-0.5 text-[12px] text-ink-2">
                          {waitingTag(row.account.waiting)}
                        </span>
                      ) : null}
                    </div>
                  );
                }
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keyboard (aria-activedescendant)
                  <div
                    key="other"
                    id={optionId(index)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    data-switch-row="other"
                    className={base + tone}
                    onClick={() => pick(row)}
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-hairline-strong text-[16px] text-ink-2"
                    >
                      +
                    </span>
                    <span>
                      {onlyOne
                        ? SWITCH_COPY.addAnother
                        : SWITCH_COPY.differentAccount}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Avatar({ name }: { name: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-[13px] font-medium text-ink-1"
    >
      {name ? ([...name][0]?.toUpperCase() ?? "") : ""}
    </span>
  );
}

/**
 * WF-SWITCH-02. The queued caution (`role="note"`) precedes the form in reading and DOM order; Cancel returns to the outgoing account
 * unchanged; offline, the form is disabled with "Signing in needs a connection." (nothing is queued: the attempt was never sent).
 */
export function SwitchSignIn({
  owner,
  target,
  failure,
  onClose,
  navigate = browserNavigate,
}: {
  owner: string;
  target: SwitchTarget;
  failure: Message | null;
  onClose(): void;
  navigate?(url: string): void;
}) {
  const session = useSession();
  const online = useOnline();
  const label = useAccountLabel();
  const waiting = useCurrentWaiting();
  const current = label ?? SWITCH_COPY.thisAccount;
  const name = target.kind === "retained" ? target.name : null;
  const title = name ? signInAs(name) : SWITCH_COPY.signInOther;
  const cautionId = useId();

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      syncControl={false}
      returnFocusRef={{ current: switchFlow.returnFocus() }}
      initialFocusSelector={
        name ? 'input[name="password"]' : 'input[name="username"]'
      }
    >
      <div className="flex flex-col gap-4" data-switch-sign-in="">
        {waiting !== null && waiting > 0 ? (
          <div
            role="note"
            id={cautionId}
            aria-label={SWITCH_COPY.cautionHeading}
            data-switch-caution=""
            className="flex flex-col gap-1 rounded-row border border-hairline-strong bg-inset p-3 text-[13px] leading-[1.6]"
          >
            <p className="font-medium text-ink-1">
              {SWITCH_COPY.cautionHeading}
            </p>
            <p className="text-ink-2">{cautionText(current, waiting)}</p>
          </div>
        ) : null}
        <SignInForm
          online={online}
          initialUsername={name ?? ""}
          submitLabel={name ? signInAs(name) : "Sign in"}
          backLabel={stayAs(current)}
          onBack={() => switchFlow.back(owner)}
          carried={failure}
          onCarriedShown={() => {
            switchFlow.failureShown(owner);
            // The controller also carried it for a neutral sign-in form; it has been shown here, so it is not news there.
            authFeedback.takeFailure();
          }}
          onSubmit={(credentials) => submitSwitch(session, owner, credentials)}
          onSso={() => submitSwitchSso(session, owner, navigate)}
        />
      </div>
    </Dialog>
  );
}

/**
 * The sign-in, and what it means for THIS flow. It is a journey of the page-memory flow (`switchFlow.submit`): leaving the credential
 * step (Cancel, Escape or Close, another account, signing out) aborts it, and the controller cancels its attempt with the session, so a
 * held exchange answered afterwards activates nothing (R1 of the review of 11 October 2026). The result can arrive after the outgoing
 * account's tree has unmounted (the incoming attempt's `activating` write closes it), so it is applied to the flow, never to component
 * state, and ONLY while it is still the flow's journey:
 *  - `settled`: another account (or a new epoch of this one) mounts; the flow is over;
 *  - `gating` / `superseded`: the neutral gate or a newer attempt owns the screen; the flow is over (the controller publishes the
 *    superseded banner);
 *  - `failed`: kept for the form, which shows it once on whichever mount of the outgoing account's tree is displayed then (an
 *    activation refused after the gate re-renders that account);
 *  - `lock_timeout`: the controller publishes the "another tab is finishing a sign-in" banner; the form stays to try again;
 *  - `cancelled`: the person left; nothing changed and there is nothing to apply.
 */
export async function submitSwitch(
  session: Session,
  owner: string,
  credentials: { username: string; password: string },
): Promise<SignInResult> {
  const journey = switchFlow.submit(owner);
  if (journey === null) return { kind: "cancelled" };
  const result = await signIn(session, credentials, journey.signal);
  if (!switchFlow.finish(journey)) return result;
  switch (result.kind) {
    case "settled":
    case "gating":
    case "superseded":
      switchFlow.close();
      break;
    case "failed":
      switchFlow.fail(owner, result.message);
      break;
    case "lock_timeout":
    case "cancelled":
      break;
  }
  return result;
}

/** Single sign-on from the credential step, as the same kind of journey: leaving the step before it navigates cancels it. */
export async function submitSwitchSso(
  session: Session,
  owner: string,
  navigate: (url: string) => void,
): Promise<SsoResult> {
  const journey = switchFlow.submit(owner);
  if (journey === null) return { kind: "cancelled" };
  const result = await startSso(
    session,
    { link: false },
    { navigate },
    journey.signal,
  );
  if (switchFlow.finish(journey) && result.kind === "gating")
    switchFlow.close();
  return result;
}

/** The flow for the account displaying now, chosen by its page-memory stage. */
export default function SwitchFlow({ owner }: { owner: string }) {
  const stage = useSyncExternalStore(
    switchFlow.subscribe,
    switchFlow.get,
    switchFlow.get,
  );
  if (stage.stage === "closed" || stage.owner !== owner) return null;
  const close = () => switchFlow.close();
  if (stage.stage === "picker")
    return <SwitchPicker owner={owner} onClose={close} />;
  return (
    <SwitchSignIn
      owner={owner}
      target={stage.target}
      failure={stage.failure}
      onClose={close}
    />
  );
}
