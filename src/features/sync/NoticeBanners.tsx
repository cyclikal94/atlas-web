import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import {
  type Notice,
  useDataActions,
  useNotices,
  useOptionalDataEnv,
} from "../../data";
import {
  COMPAT_MISSING_BODY,
  COMPAT_TITLE,
  COMPAT_UNSUPPORTED_BODY,
  DEVICE_CAPACITY_BODY,
  DEVICE_CAPACITY_TITLE,
  FLOOR_A_BODY,
  FLOOR_B_BODY,
  FLOOR_B_DRAFTS,
  FLOOR_TITLE,
  MEMORY_ONLY_NOTE,
  PAGE_NOT_SAVED_ACTION,
  PAGE_NOT_SAVED_BODY,
  PAGE_NOT_SAVED_TITLE,
  QUEUE_WARNING_BODY,
  QUEUE_WARNING_TITLE,
  STILL_TRYING_ACTION,
  STILL_TRYING_CHANGES_BODY,
  STILL_TRYING_CHANGES_TITLE,
  STILL_TRYING_UPDATES_BODY,
  STILL_TRYING_UPDATES_TITLE,
  STORAGE_FULL_ADVICE,
  STORAGE_FULL_DISMISS,
  STORAGE_FULL_INVALID_BODY,
  STORAGE_FULL_INVALID_TITLE,
  STORAGE_FULL_RETRY,
  STORAGE_FULL_VALID_BODY,
  STORAGE_FULL_VALID_TITLE,
  STORAGE_NOT_RESPONDING_ACTION,
  STORAGE_NOT_RESPONDING_BODY,
  STORAGE_NOT_RESPONDING_TITLE,
  UNRECOGNISED_ACTION,
  UNRECOGNISED_BODY,
  UNRECOGNISED_TITLE,
} from "./copy";
import { useGateMounted } from "./gate-presence";

/**
 * The banners and terminal states of plan 5.7. A banner is STATIC content (a section with a heading), never a live region of its
 * own (rule R6): a banner that newly appears is announced once through the existing announcer, never by being a live region.
 * Tone is never colour alone: the heading and the words carry the state.
 */
type Tone = "info" | "warn" | "error";
const TONE: Record<Tone, string> = {
  info: "border-hairline-strong bg-panel",
  warn: "border-missed-edge bg-missed-tint",
  error: "border-conflict-edge bg-conflict-tint",
};

export function Banner({
  kind,
  tone,
  title,
  children,
  actions,
}: {
  kind: string;
  tone: Tone;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-notice={kind}
      className={`flex max-w-[700px] flex-col gap-2 rounded-row border p-3.5 ${TONE[tone]}`}
    >
      <h2 id={heading} className="text-[14px] font-medium text-ink-1">
        {title}
      </h2>
      <div className="flex flex-col gap-1.5 text-[13px] leading-[1.6] text-ink-2">
        {children}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}

/** The floor, states (a) and (b) (WEB-05.5 Q23). No control: the copy says retrying will not help, and it must not offer one. */
export function FloorRefusal({ variant }: { variant: "a" | "b" }) {
  return (
    <Banner kind={`floor-${variant}`} tone="error" title={FLOOR_TITLE}>
      <p>{variant === "a" ? FLOOR_A_BODY : FLOOR_B_BODY}</p>
      {variant === "b" ? <p>{FLOOR_B_DRAFTS}</p> : null}
    </Banner>
  );
}

const keyOf = (notice: Notice): string =>
  notice.kind === "floor"
    ? `floor-${notice.variant}`
    : notice.kind === "storage_full"
      ? `storage_full-${notice.cache}`
      : notice.kind === "still_trying"
        ? `still_trying-${notice.scope}`
        : notice.kind === "compat_paused"
          ? `compat-${notice.reason}`
          : notice.kind;

function titleOf(notice: Notice): string {
  switch (notice.kind) {
    case "floor":
      return FLOOR_TITLE;
    case "page_not_saved":
      return PAGE_NOT_SAVED_TITLE;
    case "storage_full":
      return notice.cache === "valid"
        ? STORAGE_FULL_VALID_TITLE
        : STORAGE_FULL_INVALID_TITLE;
    case "storage_not_responding":
      return STORAGE_NOT_RESPONDING_TITLE;
    case "compat_paused":
      return COMPAT_TITLE;
    case "still_trying":
      return notice.scope === "updates"
        ? STILL_TRYING_UPDATES_TITLE
        : STILL_TRYING_CHANGES_TITLE;
    case "device_capacity":
      return DEVICE_CAPACITY_TITLE;
    case "unrecognised":
      return UNRECOGNISED_TITLE;
    case "queue_warning":
      return QUEUE_WARNING_TITLE;
  }
}

function NoticeView({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss(): void;
}) {
  const actions = useDataActions();
  switch (notice.kind) {
    case "floor":
      return <FloorRefusal variant={notice.variant} />;
    case "page_not_saved":
      return (
        <Banner
          kind="page_not_saved"
          tone="error"
          title={PAGE_NOT_SAVED_TITLE}
          actions={
            <Button variant="primary" onClick={() => actions.retryUpdates()}>
              {PAGE_NOT_SAVED_ACTION}
            </Button>
          }
        >
          <p>{PAGE_NOT_SAVED_BODY}</p>
          {notice.memoryOnly ? <p>{MEMORY_ONLY_NOTE}</p> : null}
        </Banner>
      );
    case "storage_full":
      return (
        <Banner
          kind="storage_full"
          tone="warn"
          title={titleOf(notice)}
          actions={
            <>
              <Button onClick={onDismiss}>{STORAGE_FULL_DISMISS}</Button>
              <Button
                variant="primary"
                onClick={() => {
                  actions.retryUpdates();
                  actions.retryChanges();
                }}
              >
                {STORAGE_FULL_RETRY}
              </Button>
            </>
          }
        >
          <p>
            {notice.cache === "valid"
              ? STORAGE_FULL_VALID_BODY
              : STORAGE_FULL_INVALID_BODY}
          </p>
          <p>{STORAGE_FULL_ADVICE}</p>
        </Banner>
      );
    case "storage_not_responding":
      return (
        <Banner
          kind="storage_not_responding"
          tone="error"
          title={STORAGE_NOT_RESPONDING_TITLE}
          actions={
            <Button variant="primary" onClick={() => actions.retryChanges()}>
              {STORAGE_NOT_RESPONDING_ACTION}
            </Button>
          }
        >
          <p>{STORAGE_NOT_RESPONDING_BODY}</p>
          {notice.memoryOnly ? <p>{MEMORY_ONLY_NOTE}</p> : null}
        </Banner>
      );
    case "compat_paused":
      return (
        <Banner kind="compat_paused" tone="warn" title={COMPAT_TITLE}>
          <p>
            {notice.reason === "missing"
              ? COMPAT_MISSING_BODY
              : COMPAT_UNSUPPORTED_BODY}
          </p>
        </Banner>
      );
    case "still_trying":
      return (
        <Banner
          kind={`still_trying_${notice.scope}`}
          tone="warn"
          title={titleOf(notice)}
          actions={
            <Button
              variant="primary"
              onClick={() =>
                notice.scope === "updates"
                  ? actions.retryUpdates()
                  : actions.retryChanges()
              }
            >
              {STILL_TRYING_ACTION}
            </Button>
          }
        >
          <p>
            {notice.scope === "updates"
              ? STILL_TRYING_UPDATES_BODY
              : STILL_TRYING_CHANGES_BODY}
          </p>
        </Banner>
      );
    case "device_capacity":
      return (
        <Banner
          kind="device_capacity"
          tone="error"
          title={DEVICE_CAPACITY_TITLE}
        >
          <p>{DEVICE_CAPACITY_BODY}</p>
        </Banner>
      );
    case "unrecognised":
      return (
        <Banner
          kind="unrecognised"
          tone="warn"
          title={UNRECOGNISED_TITLE}
          actions={
            <Button variant="primary" onClick={() => actions.retryUpdates()}>
              {UNRECOGNISED_ACTION}
            </Button>
          }
        >
          <p>{UNRECOGNISED_BODY}</p>
        </Banner>
      );
    case "queue_warning":
      return (
        <Banner kind="queue_warning" tone="info" title={QUEUE_WARNING_TITLE}>
          <p>
            <span className="font-num text-ink-1">{notice.total}</span> waiting
            to send
          </p>
          <p>{QUEUE_WARNING_BODY}</p>
        </Banner>
      );
  }
}

/** Announces a banner once, when it first appears; never on first render. */
function useAnnounceNew(notices: readonly Notice[]): void {
  const announcer = useAnnouncer();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const keys = new Set(notices.map(keyOf));
    if (seen.current !== null)
      for (const notice of notices)
        if (!seen.current.has(keyOf(notice)))
          announcer.announce(
            titleOf(notice),
            notice.kind === "floor" || notice.kind === "page_not_saved"
              ? "assertive"
              : "polite",
          );
    seen.current = keys;
  }, [notices, announcer]);
}

/**
 * The notices that apply, in a fixed priority. `only`/`except` choose the kinds a surface shows: the queue panel shows them all,
 * the shell shows the blocking ones everywhere (so a floor or a paused queue is never visible on one screen only).
 */
export function NoticeList({
  kinds,
  className = "",
}: {
  /** Which notice kinds this surface renders; omitted: all. */
  kinds?: ReadonlySet<Notice["kind"]>;
  className?: string;
}) {
  const all = useNotices();
  const gated = useGateMounted();
  // A CacheGate on screen draws the floor state (b) in place of the hidden content: this list must not draw it again.
  const notices = (kinds ? all.filter((n) => kinds.has(n.kind)) : all).filter(
    (n) => !(gated && n.kind === "floor" && n.variant === "b"),
  );
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const shown = notices.filter((n) => !dismissed.has(keyOf(n)));
  useAnnounceNew(shown);
  if (shown.length === 0) return null;
  return (
    <div className={`flex flex-col gap-3 ${className}`} data-notices="">
      {shown.map((notice) => (
        <NoticeView
          key={keyOf(notice)}
          notice={notice}
          onDismiss={() =>
            setDismissed((current) => new Set(current).add(keyOf(notice)))
          }
        />
      ))}
    </div>
  );
}

const GLOBAL: ReadonlySet<Notice["kind"]> = new Set([
  "floor",
  "page_not_saved",
  "storage_full",
  "storage_not_responding",
  "compat_paused",
  "still_trying",
  "device_capacity",
  "unrecognised",
]);

/** The blocking notices at the top of every screen of the shell. Renders nothing with no data layer mounted, or nothing to say. */
export function GlobalNotices() {
  const env = useOptionalDataEnv();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // The queue panel shows every notice itself: the same banner is never drawn twice on one screen.
  if (env === null || pathname === "/sync") return null;
  return <NoticeList kinds={GLOBAL} className="mb-5" />;
}
