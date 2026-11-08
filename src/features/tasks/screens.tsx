import {
  Outlet,
  useMatchRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLayoutMode } from "../../app/shell/layout-mode";
import { type TaskWrapper, useTaskWrapper } from "../../app/shell/preferences";
import { getPageDataHost } from "../../data";
import { CalendarPage } from "./calendar/CalendarPage";
import {
  registerCatchUpConflicts,
  useCatchUpService,
} from "./catchup/useCatchUp";
import { TaskDetail } from "./detail/TaskDetail";
import { TaskList } from "./detail/TaskList";
import { TasksBoundary } from "./env";
import { FocusPage } from "./focus/FocusPage";
import { TaskFormPage } from "./form/TaskFormPage";
import { ListsLayout } from "./lists/ListsLayout";
import { isKnownZone } from "./model/primitives";
import { dayEnd, todayIn } from "./model/time";
import { StreakPage } from "./streak/StreakPage";
import { TimersPage } from "./timers/TimersPage";
import { UPCOMING_HASH } from "./titles";
import { PANE_COPY, TaskPane } from "./today/TaskPane";
import { TodayPage } from "./today/TodayPage";
import type { RowOpen } from "./today/TodayRow";

/**
 * The task screens, loaded LAZILY by their routes (one chunk, never part of an initial bundle: the fixture's entry includes the protected
 * tree statically, and its initial-chunk budget has no room for them).
 */

// WEB-10c's command path (CM-432): the page's dispatcher retries a task command refused with `materialisation_required` and asks the
// catch-up runner; registered once per registry, when the task screens first load.
registerCatchUpConflicts(getPageDataHost().conflicts);

/** The device's zone: the default display zone, SHOWN on the chip and changeable (ARCH 6155: never silently inferred). */
export const deviceZone = (): string => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isKnownZone(zone) ? zone : "UTC";
};

export interface TodayScreenSearch {
  day?: string;
  tz?: string;
  task?: string;
  occurrence?: string;
  new?: boolean;
}

/**
 * The container a task opens in from this page, for this width (Settings · Layout): the phone always opens a page, and a split pane
 * needs the desktop width (below it the setting falls back to a page). The peek and the overlay fit from the tablet up.
 */
export function effectiveWrapper(
  wrapper: TaskWrapper,
  mode: "desktop" | "tablet" | "mobile",
): TaskWrapper {
  if (mode === "mobile") return "page";
  if (wrapper === "split" && mode !== "desktop") return "page";
  return wrapper;
}

export function TodayScreen(props: { search: TodayScreenSearch }) {
  return (
    <TasksBoundary>
      <TodayWithDefaults {...props} />
    </TasksBoundary>
  );
}

function TodayWithDefaults({ search }: { search: TodayScreenSearch }) {
  const navigate = useNavigate();
  const zone = search.tz ?? deviceZone();
  const [now, setNow] = useState(() => Date.now());
  const today = todayIn(zone, now);
  const to = "/today" as const;
  // Upcoming is the second half of this page: `#upcoming` starts at the fold, and the hash follows the scroll (`onSection`).
  const hash = useRouterState({ select: (state) => state.location.hash });
  const section: "today" | "upcoming" =
    hash === UPCOMING_HASH ? "upcoming" : "today";
  // How a task opens from this day (Settings · Layout, the Final design): beside it, over it, or as its own page.
  const wrapper = effectiveWrapper(useTaskWrapper(), useLayoutMode());
  const base = useMemo(
    () => ({
      ...(search.day ? { day: search.day } : {}),
      ...(search.tz ? { tz: search.tz } : {}),
    }),
    [search.day, search.tz],
  );
  const opened:
    | { kind: "new" }
    | { kind: "task"; taskId: string; occurrence?: string }
    | null =
    wrapper === "page"
      ? null
      : search.new
        ? { kind: "new" }
        : search.task
          ? {
              kind: "task",
              taskId: search.task,
              ...(search.occurrence ? { occurrence: search.occurrence } : {}),
            }
          : null;
  const close = useCallback(
    () => void navigate({ to, search: base, replace: true }),
    [navigate, to, base],
  );
  const openRow =
    wrapper === "page"
      ? undefined
      : (row: { taskId: string; id: string }): RowOpen => ({
          to,
          search: { ...base, task: row.taskId, occurrence: row.id },
        });
  const newTask: RowOpen | undefined =
    wrapper === "page" ? undefined : { to, search: { ...base, new: true } };
  // ↑ and ↓ in the side peek: the day's rows in the order shown, read from the page itself.
  const step = useCallback(
    (direction: -1 | 1) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-today-row]"),
      );
      const index = rows.findIndex(
        (row) => row.dataset.todayRow === search.occurrence,
      );
      const next = rows[index + direction];
      if (next?.dataset.taskId && next.dataset.todayRow)
        void navigate({
          to,
          search: {
            ...base,
            task: next.dataset.taskId,
            occurrence: next.dataset.todayRow,
          },
          replace: true,
        });
    },
    [navigate, to, base, search.occurrence],
  );
  // With no day in the address the view is today's, and rolls over at local midnight (R6, revision 1). The wait is capped at six hours,
  // and a wake that finds the same day arms the next wait ITSELF, so the chain continues until the day changes whatever the length of the
  // remaining wait; only a change of day re-renders. A device that slept or whose clock was changed reads the day again when the page is
  // shown or focused (a timer does not run while a device sleeps). A day in the address is the person's choice and never moves.
  useEffect(() => {
    if (search.day !== undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): boolean => {
      if (todayIn(zone, Date.now()) === today) return false;
      setNow(Date.now());
      return true;
    };
    const arm = () => {
      const wait = dayEnd(today, zone) * 1000 - Date.now() + 50;
      timer = setTimeout(
        () => {
          if (!check()) arm();
        },
        Math.max(1_000, Math.min(wait, 6 * 3_600_000)),
      );
    };
    arm();
    const resume = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [search.day, today, zone]);
  const onSection = useCallback(
    (next: "today" | "upcoming") => {
      if (next === section) return;
      void navigate({
        to,
        search: (current: TodayScreenSearch) => current,
        hash: next === "upcoming" ? UPCOMING_HASH : "",
        replace: true,
        resetScroll: false,
      });
    },
    [navigate, to, section],
  );
  const page = (
    <TodayPage
      day={search.day ?? today}
      zone={zone}
      dayGiven={search.day !== undefined}
      section={section}
      onSection={onSection}
      onChange={(next) => {
        const day = next.day ?? search.day;
        const tz = next.zone ?? search.tz;
        void navigate({
          to,
          search: {
            ...(day ? { day } : {}),
            ...(tz ? { tz } : {}),
            ...(search.task ? { task: search.task } : {}),
            ...(search.occurrence ? { occurrence: search.occurrence } : {}),
            ...(search.new ? { new: true } : {}),
          },
          replace: true,
        });
      }}
      {...(openRow ? { open: openRow } : {})}
      {...(newTask ? { newTask } : {})}
    />
  );
  if (opened === null || wrapper === "page") return page;
  const content =
    opened.kind === "new" ? (
      <TaskFormPage
        mode={{ kind: "new" }}
        embedded={{
          onClose: close,
          onSaved: (taskId) =>
            void navigate({
              to,
              search: { ...base, task: taskId },
              replace: true,
            }),
        }}
      />
    ) : (
      <TaskDetail
        key={`${opened.taskId}:${opened.occurrence ?? ""}`}
        taskId={opened.taskId}
        {...(opened.occurrence ? { occurrence: opened.occurrence } : {})}
        embedded
        onClose={close}
      />
    );
  const label = opened.kind === "new" ? PANE_COPY.newLabel : PANE_COPY.label;
  if (wrapper === "split")
    return (
      <div
        className="grid items-start gap-8 desktop:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]"
        data-today-split=""
      >
        {page}
        <TaskPane wrapper="split" label={label} onClose={close}>
          {content}
        </TaskPane>
      </div>
    );
  return (
    <>
      {page}
      <TaskPane wrapper={wrapper} label={label} onClose={close} onStep={step}>
        {content}
      </TaskPane>
    </>
  );
}

/** From 1280 px the list stays beside the detail; below it, one column with "‹ Tasks". */
export function TasksLayoutScreen() {
  return (
    <TasksBoundary>
      <TasksLayoutInner />
    </TasksBoundary>
  );
}

function TasksLayoutInner() {
  // The page's catch-up service, live on every task screen (review R8): a task command refused with `materialisation_required` on a
  // directly opened detail, the list or the account's timers finds a runner for the displayed identity.
  useCatchUpService();
  const matchRoute = useMatchRoute();
  const child =
    matchRoute({ to: "/tasks/$taskId", fuzzy: true }) !== false ||
    matchRoute({ to: "/tasks/new" }) !== false;
  // The Final design: the tasks take the page, and a task (or the form) is a page of its own.
  return (
    <div className="flex min-w-0 flex-col" data-tasks-layout="">
      {child ? (
        <Outlet />
      ) : (
        // The destination's eyebrow heading is the route's (`route.tsx`), outside the cache gate and this lazy screen.
        <div className="mt-1">
          <TaskList />
        </div>
      )}
    </div>
  );
}

export function TaskDetailScreen(props: {
  taskId: string;
  occurrence?: string;
  record?: boolean;
}) {
  return (
    <TaskDetail
      key={`${props.taskId}:${props.occurrence ?? ""}`}
      taskId={props.taskId}
      {...(props.occurrence ? { occurrence: props.occurrence } : {})}
      focusRecord={props.record === true}
    />
  );
}

export function TaskNewScreen() {
  return <TaskFormPage mode={{ kind: "new" }} />;
}

export function TaskEditScreen({ taskId }: { taskId: string }) {
  return <TaskFormPage key={taskId} mode={{ kind: "edit", taskId }} />;
}

export function TaskStreakScreen({ taskId }: { taskId: string }) {
  return <StreakPage key={taskId} taskId={taskId} />;
}

export function TimersScreen() {
  return <TimersPage />;
}

/** WEB-10b: the Lists pane beside the list detail from 1280 px (D-10b-2). */
export function ListsLayoutScreen() {
  return (
    <TasksBoundary>
      <ListsLayout />
    </TasksBoundary>
  );
}

/** Focus mode (the Final design): the day at `/focus?day=&tz=`, one thing at a time. */
export function FocusScreen({
  search,
}: {
  search: { day?: string; tz?: string };
}) {
  const zone = search.tz ?? deviceZone();
  return (
    <TasksBoundary>
      <FocusPage day={search.day ?? todayIn(zone, Date.now())} zone={zone} />
    </TasksBoundary>
  );
}

/** The calendar at `/calendar?view=month|week&weekends=1|0&at=YYYY-MM-DD&tz=`: the view, the weekends and the day in view in the address. */
export function CalendarScreen({
  search,
}: {
  search: {
    view?: "month" | "week";
    weekends?: boolean;
    at?: string;
    tz?: string;
  };
}) {
  const navigate = useNavigate();
  const zone = search.tz ?? deviceZone();
  const at = search.at ?? todayIn(zone, Date.now());
  return (
    <TasksBoundary>
      <CalendarPage
        view={search.view ?? "month"}
        weekends={search.weekends !== false}
        at={at}
        zone={zone}
        onChange={(next) => {
          const view = next.view ?? search.view ?? "month";
          const weekends = next.weekends ?? search.weekends !== false;
          void navigate({
            to: "/calendar",
            search: {
              ...(view === "week" ? { view } : {}),
              ...(weekends ? {} : { weekends: false }),
              at: next.at ?? at,
              ...(search.tz ? { tz: search.tz } : {}),
            },
            replace: true,
            // The page scrolls itself to the block (the router's reset would take the calendar back to its top).
            resetScroll: false,
          });
        }}
      />
    </TasksBoundary>
  );
}
