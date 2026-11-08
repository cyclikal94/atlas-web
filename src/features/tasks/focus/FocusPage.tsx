import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Timer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { PageHeading } from "../../../components/ui/page-heading";
import { cn } from "../../../lib/utils";
import { useTaskActions } from "../actions";
import { useCatchUpService } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { useTasksEnv } from "../env";
import {
  compareRows,
  dayLabel,
  GROUP_ORDER,
  type Group,
  groupOf,
  whoLabel,
} from "../format";
import { timeIn } from "../model/time";
import { isTimerGoal } from "../model/timers";
import { recordBlock } from "../reasons";
import { useTodayView } from "../today/useTodayView";
import type { RowModel } from "../view";

export const FOCUS_COPY = {
  title: "Focus",
  upNext: (n: number, total: number) => `Up next · ${n} of ${total}`,
  lastOne: (n: number, total: number) => `Last one · ${n} of ${total}`,
  allDone: "That's the day",
  allDoneBody:
    "Everything on today's list is done. Back to the day to add more.",
  nothing: "Nothing on today's list yet.",
  done: "Done",
  later: "Later",
  skip: "Skip",
  timer: "Timer",
  open: "Open",
  /** The "Meanwhile" aside (the Final design): what the day's shared tasks say others have done. */
  meanwhile: "Meanwhile",
  meanwhileDone: (title: string) => `${title} · done by someone else`,
  meanwhileNone: "Nothing from the others yet.",
  ofToday: (goal: string) => `of ${goal} today`,
  nothingYet: "0 min",
  deferred: "later",
  keys: "← → move between things · Esc back to the day",
  order: "Today, in order",
  wholeDay: "See the whole day",
  progress: "Progress through today",
  skipped: "skipped",
  anyTime: "any time",
  toGo: (n: number) => `${n} to go`,
} as const;

const SECTION_ORDER: readonly Group[] = [
  "any",
  ...GROUP_ORDER.filter((g) => g !== "any"),
];

/**
 * Focus mode (the Final design): one thing at a time. The day's rows in the order Today shows them; the current one large in the
 * middle with its time, its line and the two acts (Done, Skip), the keys to move between things, and beside it the day in order.
 * On the phone the order is a row of bars at the top and the acts sit at the bottom. The same records as Today's tick makes.
 */
export function FocusPage({ day, zone }: { day: string; zone: string }) {
  const env = useTasksEnv();
  useCatchUpService();
  const view = useTodayView(day, zone);
  const actions = useTaskActions();
  const navigate = useNavigate();
  const mode = useLayoutMode();
  const rows = useMemo(() => {
    const groups = new Map<Group, RowModel[]>();
    for (const row of view.rows) {
      const group = groupOf(row, day, zone);
      groups.set(group, [...(groups.get(group) ?? []), row]);
    }
    return SECTION_ORDER.flatMap((g) =>
      (groups.get(g) ?? []).sort(compareRows),
    );
  }, [view.rows, day, zone]);
  // "Later" (the Final design): a thing put off goes to the end of this session's order; the next open one comes up.
  const [deferred, setDeferred] = useState<readonly string[]>([]);
  const ordered = useMemo(() => {
    if (deferred.length === 0) return rows;
    const rank = new Map(deferred.map((id, i) => [id, i]));
    return [
      ...rows.filter((row) => !rank.has(row.id)),
      ...rows
        .filter((row) => rank.has(row.id))
        .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)),
    ];
  }, [rows, deferred]);
  const firstOpen = ordered.findIndex((row) => row.outcome !== "complete");
  const [index, setIndex] = useState<number | null>(null);
  const current =
    ordered.length === 0
      ? null
      : (ordered[
          Math.min(index ?? Math.max(firstOpen, 0), ordered.length - 1)
        ] ?? null);
  const position = current === null ? 0 : ordered.indexOf(current) + 1;
  const done = rows.filter((row) => row.outcome === "complete").length;
  const [busy, setBusy] = useState(false);
  const step = (direction: -1 | 1) =>
    setIndex((value) => {
      const from = value ?? Math.max(firstOpen, 0);
      return Math.max(0, Math.min(ordered.length - 1, from + direction));
    });
  const reason =
    current === null
      ? null
      : recordBlock(current, view.now, zone, env.writable);
  const markDone = async () => {
    if (current === null || reason !== null || busy) return;
    if (current.data.definition.goal.kind !== "checkbox") {
      void navigate({
        to: "/tasks/$taskId",
        params: { taskId: current.taskId },
        search: { occurrence: current.id, record: true },
      });
      return;
    }
    setBusy(true);
    try {
      await actions.record(
        current,
        { kind: "checkbox", complete: true },
        null,
        copy.ANNOUNCE_DONE,
      );
      // The next open thing comes up.
      setIndex(null);
    } finally {
      setBusy(false);
    }
  };
  const later = () => {
    if (current === null || current.outcome === "complete") return;
    const id = current.id;
    setDeferred((list) => [...list.filter((x) => x !== id), id]);
    setIndex(null);
  };
  const timerTask = current !== null && isTimerGoal(current.data);
  const openTimer = () => {
    if (current === null || !timerTask) return;
    void navigate({
      to: "/tasks/$taskId",
      params: { taskId: current.taskId },
      search: { occurrence: current.id },
      hash: "timer",
    });
  };
  const skip = async () => {
    if (current === null || !current.canEdit || busy) return;
    setBusy(true);
    try {
      await actions.resolve(current, true);
      setIndex(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "Escape")
        void navigate({ to: "/today", search: {} });
      else if (event.key === "d" || event.key === "D") void markDone();
      else if (event.key === "s" || event.key === "S") void skip();
      else if (event.key === "l" || event.key === "L") later();
      else if (event.key === "t" || event.key === "T") openTimer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const instant = current?.data.slot.instant ?? null;
  const timeText =
    current === null
      ? ""
      : instant !== null
        ? timeIn(instant, zone)
        : FOCUS_COPY.anyTime;
  const line =
    current === null
      ? ""
      : [
          copy.CADENCE(current.data.definition.schedule.repeat),
          current.data.definition.participation === "personal"
            ? copy.SUMMARY_LINE.justYou
            : `${copy.PARTICIPATION[current.data.definition.participation]} · ${whoLabel(current, env.accountId)}`,
          copy.CARRY[current.data.definition.carry].label,
        ].join(" · ");
  const phone = mode === "mobile";
  const acts = (
    <div
      className={cn(
        "flex gap-2",
        phone ? "grid grid-cols-2" : "w-full max-w-[460px]",
      )}
      data-focus-actions=""
    >
      {reason !== null || busy || current === null ? (
        <Button
          disabled
          reason={reason ?? copy.SAVING}
          className={cn("h-14 rounded-[14px] text-base", phone ? "" : "flex-1")}
        >
          <Check aria-hidden="true" className="size-5" strokeWidth={2.6} />
          {FOCUS_COPY.done}
        </Button>
      ) : (
        <Button
          variant="default"
          onClick={() => void markDone()}
          className={cn("h-14 rounded-[14px] text-base", phone ? "" : "flex-1")}
          data-focus-done=""
        >
          <Check aria-hidden="true" className="size-5" strokeWidth={2.6} />
          {FOCUS_COPY.done}
          {phone ? null : (
            <kbd className="font-num text-xs font-medium opacity-70">D</kbd>
          )}
        </Button>
      )}
      {current === null || current.outcome === "complete" ? null : (
        <Button
          onClick={later}
          className="h-14 rounded-[14px] text-[15px]"
          data-focus-later=""
        >
          {FOCUS_COPY.later}
          {phone ? null : (
            <kbd className="font-num text-xs text-muted-foreground">L</kbd>
          )}
        </Button>
      )}
      {current === null ? null : !current.canEdit || busy ? (
        <Button
          disabled
          reason={busy ? copy.SAVING : copy.ONLY_PARTICIPANTS}
          className="h-14 rounded-[14px] text-[15px]"
        >
          {FOCUS_COPY.skip}
        </Button>
      ) : (
        <Button
          onClick={() => void skip()}
          className="h-14 rounded-[14px] text-[15px]"
          data-focus-skip=""
        >
          {FOCUS_COPY.skip}
          {phone ? null : (
            <kbd className="font-num text-xs text-muted-foreground">S</kbd>
          )}
        </Button>
      )}
      {current === null || !timerTask ? null : (
        <Button
          onClick={openTimer}
          className="h-14 rounded-[14px] text-[15px]"
          data-focus-timer=""
        >
          <Timer aria-hidden="true" className="size-4" />
          {FOCUS_COPY.timer}
          {phone ? null : (
            <kbd className="font-num text-xs text-muted-foreground">T</kbd>
          )}
        </Button>
      )}
      {current === null || phone ? null : (
        <Button asChild className="h-14 rounded-[14px] text-[15px]">
          <Link
            to="/tasks/$taskId"
            params={{ taskId: current.taskId }}
            search={{ occurrence: current.id }}
          >
            {FOCUS_COPY.open}
          </Link>
        </Button>
      )}
    </div>
  );
  // "Meanwhile": the day's shared tasks whose joint result says someone else finished them (their names live in the streams this
  // device may not hold, so the line says what it knows).
  const meanwhile = rows.filter(
    (row) =>
      row.outcome !== "complete" &&
      row.data.definition.participation !== "personal" &&
      row.joint !== null &&
      (row.joint.outcome === "complete" || row.joint.outcome === "provisional"),
  );
  // The phone's ring (the Final design, FD_FocusPhone): a timed task's time today against its goal.
  const ring = (() => {
    if (current === null || !timerTask) return null;
    const goal = current.data.definition.goal;
    const minimum =
      goal.kind === "numeric" && goal.minimum !== null
        ? Number(goal.minimum)
        : null;
    const seconds = Number(current.progress?.period.amount ?? "0") || 0;
    const share =
      minimum === null || minimum <= 0 ? 0 : Math.min(1, seconds / minimum);
    return { seconds, minimum, share };
  })();
  const stage = view.loading ? (
    <p aria-busy="true" className="text-sm text-muted-foreground">
      {copy.LOADING}
    </p>
  ) : rows.length === 0 ? (
    <EmptyState icon={Check} data-focus-empty="">
      {FOCUS_COPY.nothing}
    </EmptyState>
  ) : current === null ? null : (
    <div
      className="relative flex flex-col items-center gap-6 text-center"
      data-focus-current={current.id}
    >
      <span className="inline-flex h-[30px] items-center gap-2 rounded-full border border-primary/40 bg-accent px-3 text-[13px] font-medium">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
        {position === rows.length
          ? FOCUS_COPY.lastOne(position, rows.length)
          : FOCUS_COPY.upNext(position, rows.length)}
      </span>
      <div className="flex max-w-[620px] flex-col items-center gap-3">
        {phone && ring !== null ? (
          <div
            className="relative flex size-[168px] items-center justify-center"
            data-focus-ring={String(Math.round(ring.share * 100))}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              className="absolute inset-0 size-full -rotate-90"
            >
              <circle
                cx="50"
                cy="50"
                r="44"
                fill="none"
                stroke="var(--border)"
                strokeWidth="6"
              />
              <circle
                cx="50"
                cy="50"
                r="44"
                fill="none"
                stroke="var(--primary)"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${(ring.share * 276.46).toFixed(1)} 276.46`}
                className="atlas-transition"
              />
            </svg>
            <div className="flex flex-col items-center gap-0.5">
              <span className="font-num text-[30px] leading-none tracking-[-0.03em] text-foreground">
                {ring.seconds < 60
                  ? FOCUS_COPY.nothingYet
                  : copy.DURATION(String(ring.seconds))}
              </span>
              {ring.minimum === null ? null : (
                <span className="text-[11px] text-muted-foreground">
                  {FOCUS_COPY.ofToday(copy.DURATION(String(ring.minimum)))}
                </span>
              )}
            </div>
          </div>
        ) : null}
        <span
          className={
            instant !== null
              ? "font-num text-[48px] leading-none tracking-[-0.04em] text-foreground tablet:text-[64px]"
              : "text-[15px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
          }
        >
          {timeText}
        </span>
        <p
          className={cn(
            "text-[32px] font-semibold leading-[1.02] tracking-[-0.035em] tablet:text-[52px]",
            current.outcome === "complete"
              ? "text-muted-foreground line-through"
              : "text-foreground",
          )}
          data-focus-title=""
        >
          {/* Keyed on the thing: the next one swaps in with a little motion. */}
          <span key={current.id} className="atlas-swap">
            {current.title ?? copy.UNTITLED}
          </span>
        </p>
        <p className="text-[15px] text-muted-foreground tablet:text-[17px]">
          {line}
        </p>
      </div>
      {phone ? null : acts}
      {phone ? null : (
        <span className="text-xs text-muted-foreground">{FOCUS_COPY.keys}</span>
      )}
    </div>
  );
  if (phone)
    return (
      <div
        className="atlas-enter flex min-h-[calc(100dvh-140px)] flex-col gap-6"
        data-focus-page=""
      >
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/today"
            search={{}}
            className="atlas-transition inline-flex min-h-11 items-center text-[13px] text-muted-foreground hover:text-foreground"
          >
            {FOCUS_COPY.wholeDay}
          </Link>
          <ul
            aria-label={FOCUS_COPY.progress}
            className="m-0 flex list-none gap-1.5 p-0"
          >
            {ordered.map((row) => (
              <li
                key={row.id}
                aria-label={row.title ?? copy.UNTITLED}
                className={cn(
                  "h-1 w-4 rounded-full",
                  row.outcome === "complete"
                    ? "bg-success"
                    : row === current
                      ? "bg-primary"
                      : "bg-border",
                )}
              />
            ))}
          </ul>
        </div>
        <PageHeading className="sr-only">{FOCUS_COPY.title}</PageHeading>
        <div className="flex flex-1 flex-col items-center justify-center">
          {stage}
        </div>
        {current === null ? null : acts}
      </div>
    );
  return (
    <div
      className="atlas-enter grid min-h-[calc(100dvh-120px)] gap-8 desktop:grid-cols-[minmax(0,1fr)_340px]"
      data-focus-page=""
    >
      <section
        aria-label={FOCUS_COPY.title}
        className="relative flex flex-col items-center justify-center gap-7 overflow-hidden rounded-[14px] p-10"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_70%)]"
        />
        <PageHeading className="sr-only">{FOCUS_COPY.title}</PageHeading>
        {stage}
      </section>
      <aside
        aria-label={FOCUS_COPY.order}
        className="flex flex-col gap-3 rounded-[14px] border border-sidebar-border bg-sidebar p-6"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {FOCUS_COPY.order}
          </h2>
          <span className="font-num text-xs text-muted-foreground">
            {done} / {rows.length}
          </span>
        </div>
        <ol
          className="m-0 flex list-none flex-col gap-1 p-0"
          data-focus-order=""
        >
          {ordered.map((row) => {
            const isCurrent = row === current;
            const isDone = row.outcome === "complete";
            const at = row.data.slot.instant;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => setIndex(rows.indexOf(row))}
                  className={cn(
                    "atlas-transition flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px]",
                    isCurrent
                      ? "border border-primary/40 bg-accent font-semibold text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-[18px] flex-none rounded-full border-2",
                      isDone
                        ? "border-success bg-success"
                        : isCurrent
                          ? "border-primary"
                          : "border-input",
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      isDone ? "line-through" : "",
                    )}
                  >
                    {row.title ?? copy.UNTITLED}
                  </span>
                  <span className="font-num text-[11px]">
                    {deferred.includes(row.id) && !isDone
                      ? FOCUS_COPY.deferred
                      : at !== null
                        ? timeIn(at, zone)
                        : row.data.slot.date === null
                          ? ""
                          : dayLabel(row.data.slot.date) === dayLabel(day)
                            ? ""
                            : dayLabel(row.data.slot.date)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {meanwhile.length === 0 ? null : (
          <div
            className="flex flex-col gap-1.5 border-t border-sidebar-border pt-3"
            data-focus-meanwhile=""
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {FOCUS_COPY.meanwhile}
            </span>
            {meanwhile.map((row) => (
              <span
                key={row.id}
                className="flex items-center gap-2 text-[13px] text-muted-foreground"
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 flex-none rounded-full bg-success"
                />
                {FOCUS_COPY.meanwhileDone(row.title ?? copy.UNTITLED)}
              </span>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
