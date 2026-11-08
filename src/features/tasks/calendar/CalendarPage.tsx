import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLayoutMode } from "../../../app/shell/layout-mode";
import { PersonAvatar } from "../../../components/ui/avatar-stack";
import { Button } from "../../../components/ui/button";
import { Pill } from "../../../components/ui/chip";
import { enterFocusLoop } from "../../../components/ui/focus-loop";
import { PageHeader } from "../../../components/ui/page-header";
import { PageHeading } from "../../../components/ui/page-heading";
import { Segmented } from "../../../components/ui/segmented";
import { cn } from "../../../lib/utils";
import { useCatchUpService } from "../catchup/useCatchUp";
import * as copy from "../copy";
import { anonymous, useUsernames } from "../detail/Rota";
import { useTasksEnv } from "../env";
import { compareRows, dayLabel, longDayLabel } from "../format";
import { addDays, timeIn, todayIn } from "../model/time";
import { SearchPill } from "../today/CommandPalette";
import { useUpcomingView } from "../today/useUpcomingView";
import type { RowModel } from "../view";
import {
  blockDays,
  blockKeyOf,
  blockStart,
  blocksIn,
  blockTitle,
  type CalendarView,
  daysBetween,
  isoWeek,
  mondayOf,
  monthEnd,
  monthLabel,
  shiftBlock,
  shiftMonth,
  weekdayIndex,
} from "./model";

export { monthEnd, shiftMonth } from "./model";

export const CALENDAR_COPY = {
  title: "Calendar",
  things: (n: number) => (n === 1 ? "1 thing" : `${n} things`),
  done: (n: number) => `${n} done`,
  previous: {
    month: "Previous month",
    week: "Previous week",
    people: "Previous week",
  },
  next: { month: "Next month", week: "Next week", people: "Next week" },
  pick: "Choose a month",
  pickOpen: (title: string) => `${title}. Choose another month`,
  yearPrevious: "Previous year",
  yearNext: "Next year",
  today: "Today",
  view: "View",
  views: { month: "Month", week: "Week", people: "People" },
  /** The "Show" row (the Final design): the household, one chip each, and Everyone. */
  show: "Show",
  everyone: "Everyone",
  you: "You",
  others: "Others",
  /** The People view ("FD_CalendarPeople"): a lane each, "Anyone · whose turn" and the week's balance. */
  people: {
    anyone: "Anyone · whose turn",
    turn: (name: string) => `→ ${name}`,
    balance: "Balance this week",
  },
  weekends: "Weekends",
  more: (n: number) => `+${n} more`,
  empty: "Nothing planned here.",
  fromDevice:
    "From what this device holds; the days ahead are planned a month at a time.",
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  weekdayLetters: ["M", "T", "W", "T", "F", "S", "S"],
  week: (n: number) => `week ${n}`,
  allDay: "all day",
  months: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
} as const;

/** The window first drawn around the day in view (whole months), and how much is added when the reader reaches an edge. */
const BEHIND = 2;
const AHEAD = 8;
const EXTEND = 6;
/** How long a scroll the page makes itself is allowed to run before the window may grow at an edge again. */
const SCROLL_SETTLE_MS = 900;
/** The room left between the bar and a block scrolled to. */
const SCROLL_GAP = 6;
/** The People view's lane column. */
const LANE_WIDTH = 168;
/** The glide's length: a short way takes less time, a long one at most this. */
const GLIDE_MS = 520;

let gliding = 0;
/**
 * A scroll of the page's own to `top` (the Final design's motion): an ease-out glide driven by frames, so it settles rather than
 * stops, and a later glide takes over from where the last one is. Reduced motion jumps.
 */
export function glide(top: number): void {
  const from = window.scrollY;
  const distance = top - from;
  if (Math.abs(distance) < 2) {
    window.scrollTo({ top });
    return;
  }
  const length = Math.min(
    GLIDE_MS,
    240 + Math.min(1, Math.abs(distance) / 1600) * (GLIDE_MS - 240),
  );
  const started = performance.now();
  const run = ++gliding;
  const step = (now: number) => {
    if (run !== gliding) return;
    const t = Math.min(1, (now - started) / length);
    // ease-out quint
    const eased = 1 - (1 - t) ** 5;
    window.scrollTo({ top: from + distance * eased });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

interface Lane {
  id: string;
  name: string;
  kind: "member" | "anyone" | "others";
}
/** A task anyone of the household does in turn (a rota), rather than each participant for themselves. */
const isAnyone = (row: RowModel) => {
  const participation = row.data.definition.participation;
  return participation === "anyone" || participation === "pooled";
};

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The block whose top has scrolled under the sticky bar: the month or week the reader is in. Measured from layout on scroll; a
 * layout engine without geometry (jsdom) reports nothing, so the block the page was opened at stays.
 */
function useCurrentBlock(
  root: HTMLElement | null,
  sticky: HTMLElement | null,
  initial: string,
  epoch: string,
): string {
  const [current, setCurrent] = useState(initial);
  // The view or the day in the address changed: the block starts again from the address.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `epoch` names the change that resets the block
  useEffect(() => setCurrent(initial), [epoch]);
  useEffect(() => {
    if (root === null || sticky === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (root.getBoundingClientRect().height === 0) return;
      // A block scrolled to sits `SCROLL_GAP` under the bar: the limit reaches past that, so it is the block in view at once.
      const limit = sticky.getBoundingClientRect().bottom + SCROLL_GAP + 4;
      let found: string | null = null;
      for (const block of root.querySelectorAll<HTMLElement>(
        "[data-calendar-block]",
      )) {
        if (block.getBoundingClientRect().top <= limit)
          found = block.dataset.calendarBlock ?? null;
        else break;
      }
      if (found !== null) setCurrent(found);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [root, sticky]);
  return current;
}

/**
 * The household calendar (the Final design, "FD_Calendar"): the eyebrow and the month (or week) as the large title, "Today", ↑ and ↓,
 * the view and the weekends at the right; the months, or the weeks, stacked without end and scrolled through, from what this device
 * holds (the same read as the days ahead, over a window of whole months that grows as the reader nears an edge). Scrolled, a compact
 * bar stays at the top as the day's does: the block in view (it opens the picker), its count, ↑ and ↓ and the weekday names. The
 * address carries the view, the weekends and the day in view, so Back and a reload keep the place. On the phone a month is its days
 * in a small grid and then its agenda ("FD_CalendarPhone"). Calendar events, people lanes and imports come with the calendar events
 * slice.
 */
export function CalendarPage({
  view,
  weekends,
  at,
  zone,
  onChange,
}: {
  view: CalendarView;
  weekends: boolean;
  at: string;
  zone: string;
  onChange(next: {
    view?: CalendarView;
    weekends?: boolean;
    at?: string;
  }): void;
}) {
  useCatchUpService();
  const mode = useLayoutMode();
  const phone = mode === "mobile";
  const now = Date.now();
  const today = todayIn(zone, now);
  const atMonth = at.slice(0, 7);
  const [win, setWin] = useState(() => ({
    start: `${shiftMonth(atMonth, -BEHIND)}-01`,
    end: monthEnd(shiftMonth(atMonth, AHEAD)),
  }));
  // A day in view outside the window (an address typed, the picker far out): the window grows to hold it, with months to spare on
  // that side so the landing is nowhere near an edge.
  useEffect(() => {
    setWin((w) =>
      at < w.start || at > w.end
        ? {
            start:
              at < w.start ? `${shiftMonth(atMonth, -EXTEND)}-01` : w.start,
            end: at > w.end ? monthEnd(shiftMonth(atMonth, EXTEND)) : w.end,
          }
        : w,
    );
  }, [at, atMonth]);
  const read = useUpcomingView(
    addDays(win.start, -1),
    zone,
    now,
    daysBetween(win.start, win.end) + 1,
  );
  // A wider window reads again; what was read stays on screen until the new read lands (never a blank calendar between windows).
  const lastRows = useRef<RowModel[]>([]);
  if (!read.loading) lastRows.current = read.rows;
  const all = read.loading ? lastRows.current : read.rows;
  // The household's lanes (the Final design's "Show" row and People view): you first, then the household's other members by name;
  // a task of anyone's (a rota) is in the "Anyone" lane with whose turn it is; a participant outside the household is "Others".
  const me = useTasksEnv().accountId;
  const usernames = useUsernames();
  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = [
      { id: me, name: usernames.get(me) ?? CALENDAR_COPY.you, kind: "member" },
    ];
    for (const [id, name] of [...usernames].sort((a, b) =>
      a[1].localeCompare(b[1]),
    ))
      if (id !== me) out.push({ id, name, kind: "member" });
    return out;
  }, [me, usernames]);
  // "Show": everyone, or one person (their tasks, and the rota's when the turn is theirs); kept for the visit, not the address.
  const [who, setWho] = useState<string>("everyone");
  const rows = useMemo(
    () =>
      who === "everyone"
        ? all
        : all.filter(
            (row) =>
              row.data.participants.includes(who) ||
              (isAnyone(row) && row.data.rota?.account_id === who),
          ),
    [all, who],
  );
  const byDay = useMemo(() => {
    const out = new Map<string, RowModel[]>();
    for (const row of rows) {
      const date = row.data.slot.date;
      if (date === null) continue;
      out.set(date, [...(out.get(date) ?? []), row]);
    }
    for (const [date, list] of out) out.set(date, list.sort(compareRows));
    return out;
  }, [rows]);
  const blocks = useMemo(
    () => blocksIn(win.start, win.end, view),
    [win.start, win.end, view],
  );
  const countIn = useCallback(
    (key: string) =>
      blockDays(key, view).reduce(
        (n, day) =>
          n +
          (!weekends && weekdayIndex(day) >= 5
            ? 0
            : (byDay.get(day)?.length ?? 0)),
        0,
      ),
    [byDay, view, weekends],
  );

  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [sticky, setSticky] = useState<HTMLElement | null>(null);
  const measured = useCurrentBlock(
    root,
    sticky,
    blockKeyOf(at, view),
    `${view}\u0000${at}`,
  );
  // A key measured under the other view (the render between a view change and the block's reset) is not this view's: the day in
  // the address stands in until the measure runs again.
  const current = (view === "month"
    ? /^\d{4}-\d{2}$/
    : /^\d{4}-\d{2}-\d{2}$/
  ).test(measured)
    ? measured
    : blockKeyOf(at, view);
  const [stickyHeight, setStickyHeight] = useState(0);
  useEffect(() => {
    if (sticky === null) return;
    const measure = () =>
      setStickyHeight(sticky.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(sticky);
    return () => observer.disconnect();
  }, [sticky]);

  // Scrolling to a block: smooth when it is near, a jump to just short of it and then smooth when it is far (a year away arrives at
  // once but still lands with motion); instant under reduced motion or where there is no layout. While it runs the window does not
  // grow at an edge (a prepend would move the target from under the glide).
  const settling = useRef(0);
  const scrollToBlock = useCallback(
    (key: string, behavior: "smooth" | "instant" = "smooth") => {
      const el = root?.querySelector<HTMLElement>(
        `[data-calendar-block="${key}"]`,
      );
      if (!el || el.getBoundingClientRect().height === 0) return false;
      const offset =
        (sticky?.getBoundingClientRect().height ?? 0) +
        (Number.parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        ) || 0);
      const target = Math.max(
        0,
        el.getBoundingClientRect().top + window.scrollY - offset - SCROLL_GAP,
      );
      settling.current = Date.now() + SCROLL_SETTLE_MS;
      if (behavior === "instant" || reducedMotion()) {
        window.scrollTo({ top: target });
        return true;
      }
      const far = window.innerHeight * 3;
      const distance = target - window.scrollY;
      if (Math.abs(distance) > far)
        window.scrollTo({
          top: target - Math.sign(distance) * window.innerHeight * 1.5,
        });
      glide(target);
      return true;
    },
    [root, sticky],
  );
  // The block to scroll to once it exists (the window had to grow first).
  const pending = useRef<{
    key: string;
    behavior: "smooth" | "instant";
  } | null>(null);
  const writtenAt = useRef<string | null>(null);
  const opened = useRef(false);
  const seenAt = useRef(at);
  useEffect(() => {
    if (root === null) return;
    let want = pending.current;
    if (want === null && !opened.current)
      want = { key: blockKeyOf(at, view), behavior: "instant" };
    else if (want === null && seenAt.current !== at && writtenAt.current !== at)
      want = { key: blockKeyOf(at, view), behavior: "smooth" };
    opened.current = true;
    seenAt.current = at;
    if (want === null) return;
    if (scrollToBlock(want.key, want.behavior)) pending.current = null;
    else pending.current = want;
  });
  const go = (day: string, behavior: "smooth" | "instant" = "smooth") => {
    writtenAt.current = day;
    const key = blockKeyOf(day, view);
    pending.current = { key, behavior };
    onChange({ at: day });
    if (scrollToBlock(key, behavior)) pending.current = null;
  };

  // The window grows when the reader nears an edge; a prepend keeps the viewport where it was (the added height is measured and the
  // page scrolled by it before paint). Not while a scroll of the page's own is still gliding.
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const cooling = useRef(0);
  useEffect(() => {
    if (root === null) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      if (root.getBoundingClientRect().height === 0) return;
      const nowMs = Date.now();
      if (nowMs < cooling.current || nowMs < settling.current) return;
      const height = document.documentElement.scrollHeight;
      if (window.scrollY < window.innerHeight) {
        const first = root.querySelector<HTMLElement>("[data-calendar-block]");
        if (first)
          anchor.current = {
            key: first.dataset.calendarBlock ?? "",
            top: first.getBoundingClientRect().top,
          };
        cooling.current = nowMs + 400;
        setWin((w) => ({
          ...w,
          start: `${shiftMonth(w.start.slice(0, 7), -EXTEND)}-01`,
        }));
      } else if (window.scrollY + window.innerHeight * 2 > height) {
        cooling.current = nowMs + 400;
        setWin((w) => ({
          ...w,
          end: monthEnd(shiftMonth(w.end.slice(0, 7), EXTEND)),
        }));
      }
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [root]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's start names the prepend this effect undoes
  useLayoutEffect(() => {
    const held = anchor.current;
    if (held === null || root === null) return;
    anchor.current = null;
    const el = root.querySelector<HTMLElement>(
      `[data-calendar-block="${held.key}"]`,
    );
    if (!el || el.getBoundingClientRect().height === 0) return;
    window.scrollBy(0, el.getBoundingClientRect().top - held.top);
  }, [root, win.start]);

  const step = (by: -1 | 1) =>
    go(blockStart(shiftBlock(current, view, by), view));
  const columns = weekends ? 7 : 5;
  const weekdays = (
    phone ? CALENDAR_COPY.weekdayLetters : CALENDAR_COPY.weekdays
  ).slice(0, columns);
  const [picking, setPicking] = useState(false);
  const titleButton = useRef<HTMLButtonElement>(null);
  const title = blockTitle(current, view);
  const count = countIn(current);
  const dayLink = (day: string) => ({
    to: "/today" as const,
    search: { day, tz: zone },
  });
  const summary =
    view === "week"
      ? `${CALENDAR_COPY.week(isoWeek(current))} · ${CALENDAR_COPY.things(count)}`
      : CALENDAR_COPY.things(count);
  return (
    <div
      ref={setRoot}
      className="atlas-enter flex min-w-0 flex-col"
      data-calendar-page=""
      data-calendar-view={view}
      data-calendar-weekends={weekends ? "on" : "off"}
    >
      {/* The page's header (the Final design), and it stays: the eyebrow, the block in view as the large title (it opens the picker),
          its count, "Today", ↑ and ↓, the view and the weekends, then the weekday names over the columns. As the reader scrolls, the
          next month takes the title; the month is named here and nowhere else. */}
      <div
        ref={setSticky}
        className="sticky top-[var(--shell-inset-top,0px)] z-20 -mt-4 flex flex-col gap-3 border-b border-border/70 bg-background/92 pt-4 pb-2 backdrop-blur tablet:-mt-9 tablet:pt-9 tablet:pb-2.5"
        data-calendar-sticky=""
      >
        <PageHeader
          eyebrow={<PageHeading eyebrow>{CALENDAR_COPY.title}</PageHeading>}
          title={
            <div className="relative">
              <button
                ref={titleButton}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={picking}
                aria-label={CALENDAR_COPY.pickOpen(title)}
                data-calendar-month={current}
                onClick={() => setPicking((open) => !open)}
                className="atlas-transition -ml-1 flex max-w-full items-center gap-2 rounded-md px-1 text-left text-[30px] font-semibold leading-[1.05] tracking-[-0.035em] text-foreground hover:text-primary tablet:text-[40px]"
              >
                <span
                  key={title}
                  className="atlas-swap whitespace-nowrap"
                  data-calendar-title=""
                >
                  {title}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-5 flex-none text-muted-foreground transition-transform",
                    picking ? "rotate-180" : "",
                  )}
                />
              </button>
              {picking ? (
                <MonthPicker
                  current={current}
                  view={view}
                  today={today}
                  onPick={(day) => {
                    setPicking(false);
                    go(day);
                  }}
                  onClose={() => setPicking(false)}
                  returnTo={titleButton}
                />
              ) : null}
            </div>
          }
          summary={phone ? undefined : summary}
          actions={
            <>
              {phone ? null : (
                <SearchPill
                  day={today}
                  zone={zone}
                  className="w-[220px] flex-none"
                />
              )}
              <Pill
                onClick={() => go(today)}
                data-calendar-today=""
                className="h-10 px-3.5"
              >
                {CALENDAR_COPY.today}
              </Pill>
              <span className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={CALENDAR_COPY.previous[view]}
                  data-calendar-previous=""
                  onClick={() => step(-1)}
                  className="size-10 rounded-full"
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={CALENDAR_COPY.next[view]}
                  data-calendar-next=""
                  onClick={() => step(1)}
                  className="size-10 rounded-full"
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </span>
              <span
                aria-hidden="true"
                className="mx-1 hidden h-6 w-px bg-border tablet:block"
              />
              <Segmented
                label={CALENDAR_COPY.view}
                value={view}
                options={[
                  { value: "month", label: CALENDAR_COPY.views.month },
                  { value: "week", label: CALENDAR_COPY.views.week },
                  { value: "people", label: CALENDAR_COPY.views.people },
                ]}
                onChange={(next) => onChange({ view: next })}
              />
              <Pill
                pressed={weekends}
                onClick={() => onChange({ weekends: !weekends })}
                data-calendar-weekends-toggle=""
              >
                {CALENDAR_COPY.weekends}
              </Pill>
            </>
          }
          data-calendar-controls=""
        />
        {/* "Show" (the Final design): the household as chips, and Everyone. */}
        <div
          className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none]"
          data-calendar-show=""
        >
          <span className="flex-none text-xs text-muted-foreground">
            {CALENDAR_COPY.show}
          </span>
          <Pill
            pressed={who === "everyone"}
            onClick={() => setWho("everyone")}
            className="h-9 flex-none"
            data-calendar-show-everyone=""
          >
            {CALENDAR_COPY.everyone}
          </Pill>
          {lanes.map((lane) => (
            <Pill
              key={lane.id}
              pressed={who === lane.id}
              onClick={() => setWho(who === lane.id ? "everyone" : lane.id)}
              className="h-9 flex-none gap-2 pl-1.5"
              data-calendar-show-person={lane.id}
            >
              <PersonAvatar id={lane.id} name={lane.name} size={24} />
              {lane.name}
            </Pill>
          ))}
        </div>
        {phone && view !== "month" ? null : (
          <div
            className="grid gap-1.5"
            style={{
              gridTemplateColumns:
                view === "people"
                  ? `${LANE_WIDTH}px repeat(${columns}, minmax(0, 1fr))`
                  : `repeat(${columns}, minmax(0, 1fr))`,
            }}
            data-calendar-weekdays=""
          >
            {view === "people" ? <span aria-hidden="true" /> : null}
            {weekdays.map((name, n) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the letters repeat (T, S); the column is the identity
                key={`${name}-${n}`}
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground",
                  phone ? "text-center" : "px-1.5",
                )}
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col" data-calendar-grid="">
        {blocks.map((key) => (
          <Block
            key={key}
            blockKey={key}
            view={view}
            weekends={weekends}
            byDay={byDay}
            lanes={
              who === "everyone" ? lanes : lanes.filter((l) => l.id === who)
            }
            others={who === "everyone"}
            usernames={usernames}
            today={today}
            zone={zone}
            phone={phone}
            stickyHeight={stickyHeight}
            dayLink={dayLink}
            current={key === current}
          />
        ))}
      </div>
    </div>
  );
}

type DayLink = (day: string) => {
  to: "/today";
  search: { day: string; tz: string };
};

/** One month, or one week, of the calendar: its label row and its days. */
function Block({
  blockKey,
  view,
  weekends,
  byDay,
  lanes,
  others: othersLane,
  usernames,
  today,
  zone,
  phone,
  stickyHeight,
  dayLink,
  current,
}: {
  blockKey: string;
  view: CalendarView;
  weekends: boolean;
  byDay: ReadonlyMap<string, RowModel[]>;
  lanes: readonly Lane[];
  /** Whether a participant outside the lanes gets an "Others" lane (not when the week is narrowed to one person). */
  others: boolean;
  usernames: ReadonlyMap<string, string>;
  today: string;
  zone: string;
  phone: boolean;
  stickyHeight: number;
  dayLink: DayLink;
  current: boolean;
}) {
  const heading = useId();
  const title = blockTitle(blockKey, view);
  const days = blockDays(blockKey, view);
  const shown = (day: string) =>
    (weekends || weekdayIndex(day) < 5 ? byDay.get(day) : undefined) ?? [];
  const total = days.reduce((n, day) => n + shown(day).length, 0);
  // The header names the block in view; here the block's name is for assistive technology only (the month is written once).
  const label = (
    <h2 id={heading} className="sr-only">
      {view === "month"
        ? `${title} · ${CALENDAR_COPY.things(total)}`
        : `${title} · ${CALENDAR_COPY.week(isoWeek(blockKey))} · ${CALENDAR_COPY.things(total)}`}
    </h2>
  );
  const sectionProps = {
    "aria-labelledby": heading,
    "data-calendar-block": blockKey,
    "data-calendar-current": current ? "" : undefined,
    className: "pt-4",
    style: { scrollMarginTop: stickyHeight + SCROLL_GAP },
  };
  if (view === "people")
    return (
      <section {...sectionProps}>
        {label}
        <PeopleWeek
          days={days.filter((day) => weekends || weekdayIndex(day) < 5)}
          byDay={byDay}
          lanes={lanes}
          othersLane={othersLane}
          usernames={usernames}
          today={today}
          zone={zone}
          phone={phone}
          dayLink={dayLink}
        />
      </section>
    );
  if (phone) {
    const agendaDays =
      view === "week"
        ? days.filter((day) => weekends || weekdayIndex(day) < 5)
        : days.filter((day) => shown(day).length > 0);
    return (
      <section {...sectionProps}>
        {label}
        {view === "month" ? (
          <MiniMonth
            month={blockKey}
            weekends={weekends}
            byDay={byDay}
            today={today}
            dayLink={dayLink}
          />
        ) : null}
        <Agenda
          days={agendaDays}
          byDay={byDay}
          today={today}
          zone={zone}
          dayLink={dayLink}
        />
      </section>
    );
  }
  // The desktop's grid: the weeks of the month (the days of the months before and after, dimmed, keep the columns), or the one week.
  const weeks: string[][] = [];
  if (view === "month") {
    const start = mondayOf(days[0] as string);
    const end = addDays(mondayOf(days[days.length - 1] as string), 6);
    for (let monday = start; monday <= end; monday = addDays(monday, 7)) {
      const week: string[] = [];
      for (let n = 0; n < (weekends ? 7 : 5); n += 1)
        week.push(addDays(monday, n));
      if (week.some((day) => day.slice(0, 7) === blockKey)) weeks.push(week);
    }
  } else weeks.push(days.filter((day) => weekends || weekdayIndex(day) < 5));
  return (
    <section {...sectionProps}>
      {label}
      <table
        aria-labelledby={heading}
        className="w-full table-fixed border-separate border-spacing-px overflow-hidden rounded-[14px] border border-border bg-border"
      >
        <thead className="sr-only">
          <tr>
            {CALENDAR_COPY.weekdays.slice(0, weekends ? 7 : 5).map((name) => (
              <th key={name} scope="col">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => (
                <DayCell
                  key={day}
                  day={day}
                  rows={byDay.get(day) ?? []}
                  outside={view === "month" && day.slice(0, 7) !== blockKey}
                  tall={view === "week"}
                  today={day === today}
                  zone={zone}
                  dayLink={dayLink}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A day of the desktop's grid: a card with the day's number and its rows, "+N more" past three in a month. */
function DayCell({
  day,
  rows,
  outside,
  tall,
  today,
  zone,
  dayLink,
}: {
  day: string;
  rows: RowModel[];
  outside: boolean;
  tall: boolean;
  today: boolean;
  zone: string;
  dayLink: DayLink;
}): ReactElement {
  const shown = tall ? rows : rows.slice(0, 3);
  const number = Number(day.slice(8, 10));
  return (
    // One cell of the month's box (the facts strip's look: hairlines inside, the box's corners outside), the same height whether or
    // not the day holds anything; a week's cells grow with their rows.
    <td
      data-calendar-day={day}
      data-calendar-outside={outside ? "" : undefined}
      className={cn(
        "bg-card p-1.5 align-top",
        tall ? "min-h-[240px]" : "h-[132px]",
        today ? "bg-accent/40" : "",
      )}
    >
      <div
        className={cn(
          "flex flex-col gap-[3px] overflow-hidden",
          tall ? "" : "h-[120px]",
          outside ? "opacity-55" : "",
        )}
      >
        <Link
          {...dayLink(day)}
          aria-label={dayLabel(day)}
          className={cn(
            "atlas-transition inline-flex h-[22px] min-w-[22px] items-center justify-center self-start rounded-full px-[5px] font-num text-xs font-semibold hover:bg-accent",
            today
              ? "bg-primary text-primary-foreground"
              : outside
                ? "text-muted-foreground"
                : "text-foreground",
          )}
        >
          {number === 1 && !tall
            ? `${number} ${monthLabel(day.slice(0, 7)).split(" ")[0]?.slice(0, 3)}`
            : number}
        </Link>
        {shown.map((row) => (
          <Row key={row.id} row={row} zone={zone} />
        ))}
        {rows.length > shown.length ? (
          <Link
            {...dayLink(day)}
            className="px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {CALENDAR_COPY.more(rows.length - shown.length)}
          </Link>
        ) : null}
      </div>
    </td>
  );
}

/**
 * The People view of a week ("FD_CalendarPeople"): a lane per member of the household (you first), each day's tasks as chips in the
 * lane of whoever takes part, a task of anyone's in the "Anyone · whose turn" lane with the rota's answer, a participant outside the
 * household under "Others", and the week's balance (how many things each lane holds) at the end. On the phone a lane at a time.
 */
function PeopleWeek({
  days,
  byDay,
  lanes,
  othersLane,
  usernames,
  today,
  zone,
  phone,
  dayLink,
}: {
  days: string[];
  byDay: ReadonlyMap<string, RowModel[]>;
  lanes: readonly Lane[];
  othersLane: boolean;
  usernames: ReadonlyMap<string, string>;
  today: string;
  zone: string;
  phone: boolean;
  dayLink: DayLink;
}) {
  const cells = new Map<string, Map<string, RowModel[]>>();
  const put = (lane: string, day: string, row: RowModel) => {
    const byLane = cells.get(lane) ?? new Map<string, RowModel[]>();
    byLane.set(day, [...(byLane.get(day) ?? []), row]);
    cells.set(lane, byLane);
  };
  const known = new Set(lanes.map((lane) => lane.id));
  let anyone = false;
  let others = false;
  for (const day of days)
    for (const row of byDay.get(day) ?? []) {
      if (isAnyone(row)) {
        anyone = true;
        put("anyone", day, row);
        continue;
      }
      for (const id of row.data.participants)
        if (known.has(id)) put(id, day, row);
        else if (othersLane) {
          others = true;
          put("others", day, row);
        }
    }
  const shown: Lane[] = [
    ...lanes,
    ...(anyone
      ? [
          {
            id: "anyone",
            name: CALENDAR_COPY.people.anyone,
            kind: "anyone" as const,
          },
        ]
      : []),
    ...(others
      ? [{ id: "others", name: CALENDAR_COPY.others, kind: "others" as const }]
      : []),
  ];
  const countOf = (lane: string) =>
    [...(cells.get(lane)?.values() ?? [])].reduce(
      (n, list) => n + list.length,
      0,
    );
  const chip = (row: RowModel) => {
    const turn = row.data.rota?.account_id ?? null;
    const name =
      turn === null
        ? null
        : (usernames.get(turn) ?? (turn ? anonymous(turn) : null));
    return (
      <Row
        key={row.id}
        row={row}
        zone={zone}
        {...(isAnyone(row) && name !== null
          ? { tag: CALENDAR_COPY.people.turn(name) }
          : {})}
      />
    );
  };
  const laneHead = (lane: Lane) => (
    <span className="flex min-w-0 items-center gap-2">
      {lane.kind === "member" ? (
        <PersonAvatar id={lane.id} name={lane.name} size={24} />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-6 flex-none items-center justify-center rounded-full border border-dashed border-input text-[11px] text-muted-foreground"
        >
          ?
        </span>
      )}
      <span className="min-w-0 text-[13px] font-medium leading-tight text-foreground">
        {lane.name}
      </span>
    </span>
  );
  const balance = (
    <p
      className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-xs text-muted-foreground"
      data-calendar-balance=""
    >
      <span className="font-semibold uppercase tracking-[0.08em]">
        {CALENDAR_COPY.people.balance}
      </span>
      {shown.map((lane) => (
        <span key={lane.id} data-calendar-balance-lane={lane.id}>
          {lane.name}{" "}
          <span className="font-num text-foreground">{countOf(lane.id)}</span>
        </span>
      ))}
    </p>
  );
  if (phone)
    return (
      <div className="flex flex-col gap-4">
        {shown.map((lane) => (
          <section
            key={lane.id}
            className="flex flex-col gap-1"
            data-calendar-lane={lane.id}
          >
            {laneHead(lane)}
            {days
              .filter((day) => (cells.get(lane.id)?.get(day)?.length ?? 0) > 0)
              .map((day) => (
                <div key={day} className="flex flex-col gap-1 pl-8">
                  <Link
                    {...dayLink(day)}
                    className="font-num text-[11px] text-muted-foreground"
                  >
                    {dayLabel(day)}
                  </Link>
                  {(cells.get(lane.id)?.get(day) ?? []).map(chip)}
                </div>
              ))}
          </section>
        ))}
        {balance}
      </div>
    );
  return (
    <>
      <table className="w-full table-fixed border-separate border-spacing-px overflow-hidden rounded-[14px] border border-border bg-border">
        <colgroup>
          <col style={{ width: LANE_WIDTH }} />
          {days.map((day) => (
            <col key={day} />
          ))}
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th scope="col">{CALENDAR_COPY.show}</th>
            {days.map((day) => (
              <th key={day} scope="col">
                {dayLabel(day)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((lane) => (
            <tr key={lane.id} data-calendar-lane={lane.id}>
              <th scope="row" className="bg-card p-2 text-left align-top">
                {laneHead(lane)}
              </th>
              {days.map((day) => (
                <td
                  key={day}
                  data-calendar-day={day}
                  className={cn(
                    "min-h-[72px] bg-card p-1.5 align-top",
                    day === today ? "bg-accent/40" : "",
                  )}
                >
                  <div className="flex min-h-[60px] flex-col gap-[3px]">
                    {(cells.get(lane.id)?.get(day) ?? []).map(chip)}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {balance}
    </>
  );
}

/** The phone's month: its days in a small grid, the number lit when it is today, a dot a thing (up to three), each day leading to it. */
function MiniMonth({
  month,
  weekends,
  byDay,
  today,
  dayLink,
}: {
  month: string;
  weekends: boolean;
  byDay: ReadonlyMap<string, RowModel[]>;
  today: string;
  dayLink: DayLink;
}) {
  const first = `${month}-01`;
  const last = monthEnd(month);
  const cells: string[] = [];
  for (
    let d = mondayOf(first);
    d <= addDays(mondayOf(last), 6);
    d = addDays(d, 1)
  )
    if (weekends || weekdayIndex(d) < 5) cells.push(d);
  return (
    <div
      className="grid gap-1"
      style={{
        gridTemplateColumns: `repeat(${weekends ? 7 : 5}, minmax(0, 1fr))`,
      }}
      data-calendar-mini=""
    >
      {cells.map((day) => {
        const outside = day.slice(0, 7) !== month;
        const list = byDay.get(day) ?? [];
        return (
          <Link
            key={day}
            {...dayLink(day)}
            aria-label={dayLabel(day)}
            data-calendar-day={day}
            data-calendar-outside={outside ? "" : undefined}
            className={cn(
              "flex min-h-11 flex-col items-center gap-0.5 rounded-md py-1",
              outside ? "opacity-45" : "",
            )}
          >
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-full font-num text-xs",
                day === today
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "text-foreground",
              )}
            >
              {Number(day.slice(8, 10))}
            </span>
            <span className="flex h-1.5 gap-0.5" aria-hidden="true">
              {list.slice(0, 3).map((row) => (
                <span
                  key={row.id}
                  className={cn(
                    "size-1.5 rounded-full",
                    row.outcome === "complete" ? "bg-success" : "bg-primary",
                  )}
                />
              ))}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** The phone's agenda: a day at a time ("Monday 26 · today", "4 things · 2 done"), every task a row with its time. */
function Agenda({
  days,
  byDay,
  today,
  zone,
  dayLink,
}: {
  days: string[];
  byDay: ReadonlyMap<string, RowModel[]>;
  today: string;
  zone: string;
  dayLink: DayLink;
}) {
  if (days.length === 0)
    return (
      <p className="py-3 text-sm text-muted-foreground">
        {CALENDAR_COPY.empty}
      </p>
    );
  return (
    <ol className="m-0 flex list-none flex-col p-0" data-calendar-agenda="">
      {days.map((day) => {
        const list = byDay.get(day) ?? [];
        const done = list.filter((row) => row.outcome === "complete").length;
        return (
          <li key={day} className="flex flex-col py-2">
            <Link
              {...dayLink(day)}
              className="flex min-h-9 flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-foreground"
              data-calendar-agenda-day={day}
            >
              {longDayLabel(day).replace(/ \w+$/, "")}
              {day === today ? (
                <span className="text-muted-foreground">
                  {` · ${copy.SUMMARY_LINE.today.toLowerCase()}`}
                </span>
              ) : null}
              <span className="w-full text-xs font-normal text-muted-foreground">
                {CALENDAR_COPY.things(list.length)}
                {done > 0 ? ` · ${CALENDAR_COPY.done(done)}` : ""}
              </span>
            </Link>
            {list.map((row) => (
              <Row key={row.id} row={row} zone={zone} agenda />
            ))}
          </li>
        );
      })}
    </ol>
  );
}

/** The picker under the bar's title: a year, its twelve months and Today. Choosing scrolls the calendar there. */
function MonthPicker({
  current,
  view,
  today,
  onPick,
  onClose,
  returnTo,
}: {
  current: string;
  view: CalendarView;
  today: string;
  onPick(day: string): void;
  onClose(): void;
  returnTo: RefObject<HTMLButtonElement | null>;
}) {
  const start = blockStart(current, view);
  const [year, setYear] = useState(Number(start.slice(0, 4)));
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    (
      node.querySelector<HTMLElement>("[aria-current=true]") ??
      node.querySelector<HTMLElement>("button")
    )?.focus();
    const release = enterFocusLoop(node);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (node.contains(target) || returnTo.current?.contains(target)) return;
      onClose();
    };
    node.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      release();
      node.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
      if (returnTo.current?.isConnected) returnTo.current.focus();
    };
  }, [onClose, returnTo]);
  const currentMonth = start.slice(0, 7);
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={CALENDAR_COPY.pick}
      tabIndex={-1}
      data-calendar-picker=""
      className="absolute left-0 top-full z-30 mt-2 flex w-[300px] max-w-[calc(100vw-32px)] flex-col gap-2.5 rounded-[14px] border border-border bg-popover p-3 text-popover-foreground shadow-[0_24px_60px_-20px_rgba(0,0,0,.85)]"
    >
      <div className="flex items-center justify-between gap-2 text-sm font-semibold">
        <button
          type="button"
          aria-label={CALENDAR_COPY.yearPrevious}
          onClick={() => setYear((y) => y - 1)}
          className="atlas-transition flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          ‹
        </button>
        <span className="font-num" data-calendar-picker-year={String(year)}>
          {year}
        </span>
        <button
          type="button"
          aria-label={CALENDAR_COPY.yearNext}
          onClick={() => setYear((y) => y + 1)}
          className="atlas-transition flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {CALENDAR_COPY.months.map((name, n) => {
          const month = `${year}-${String(n + 1).padStart(2, "0")}`;
          const chosen = month === currentMonth;
          return (
            <button
              key={name}
              type="button"
              aria-label={monthLabel(month)}
              aria-current={chosen ? "true" : undefined}
              onClick={() => onPick(`${month}-01`)}
              className={cn(
                "atlas-transition h-9 rounded-md text-[13px]",
                chosen
                  ? "bg-primary font-semibold text-primary-foreground"
                  : month === today.slice(0, 7)
                    ? "bg-accent text-foreground hover:bg-accent"
                    : "text-foreground hover:bg-accent",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
      <div className="flex justify-end border-t border-border pt-2">
        <Pill onClick={() => onPick(today)} data-calendar-picker-today="">
          {CALENDAR_COPY.today}
        </Pill>
      </div>
    </div>
  );
}

/** A task on a day: its dot, its title and its time (the Final design's cell row); on the agenda the time leads. */
function Row({
  row,
  zone,
  agenda = false,
  tag,
}: {
  row: RowModel;
  zone: string;
  agenda?: boolean;
  /** A grey word after the title ("→ Sam", whose turn it is). */
  tag?: string;
}) {
  const instant = row.data.slot.instant;
  const done = row.outcome === "complete";
  const time: ReactNode = (
    <span className="flex-none font-num text-[11px] text-muted-foreground">
      {instant !== null
        ? timeIn(instant, zone)
        : agenda
          ? CALENDAR_COPY.allDay
          : ""}
    </span>
  );
  return (
    <Link
      to="/tasks/$taskId"
      params={{ taskId: row.taskId }}
      search={{ occurrence: row.id }}
      data-calendar-row={row.id}
      className={cn(
        "atlas-transition flex min-w-0 items-center gap-1.5 rounded-md hover:bg-accent",
        agenda
          ? "min-h-10 px-1 text-[14px] text-foreground"
          : "min-h-6 bg-background px-1.5 text-[11px] leading-[1.2] text-foreground",
        done ? "text-muted-foreground line-through" : "",
      )}
    >
      {agenda ? time : null}
      <span
        aria-hidden="true"
        className={cn(
          "size-[7px] flex-none rounded-full",
          done ? "bg-muted-foreground" : "bg-primary",
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {row.title ?? copy.UNTITLED}
        {tag ? (
          <span className="text-muted-foreground" data-calendar-turn="">
            {` ${tag}`}
          </span>
        ) : null}
      </span>
      {agenda ? null : time}
    </Link>
  );
}
