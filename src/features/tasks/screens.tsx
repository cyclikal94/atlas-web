import { Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { TASKS_TITLE } from "./copy";
import { TaskDetail } from "./detail/TaskDetail";
import { TaskList } from "./detail/TaskList";
import { TasksBoundary } from "./env";
import { TaskFormPage } from "./form/TaskFormPage";
import { isKnownZone } from "./model/primitives";
import { dayEnd, todayIn } from "./model/time";
import { TodayPage } from "./today/TodayPage";

/**
 * The task screens, loaded LAZILY by their routes (one chunk, never part of an initial bundle: the fixture's entry includes the protected
 * tree statically, and its initial-chunk budget has no room for them).
 */

/** The device's zone: the default display zone, SHOWN on the chip and changeable (ARCH 6155: never silently inferred). */
export const deviceZone = (): string => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isKnownZone(zone) ? zone : "UTC";
};

export function TodayScreen(props: { search: { day?: string; tz?: string } }) {
  return (
    <TasksBoundary>
      <TodayWithDefaults {...props} />
    </TasksBoundary>
  );
}

function TodayWithDefaults({
  search,
}: {
  search: { day?: string; tz?: string };
}) {
  const navigate = useNavigate();
  const zone = search.tz ?? deviceZone();
  const [now, setNow] = useState(() => Date.now());
  const today = todayIn(zone, now);
  // With no day in the address the view is today's, and rolls over at local midnight.
  useEffect(() => {
    if (search.day !== undefined) return;
    const wait = dayEnd(today, zone) * 1000 - Date.now() + 50;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1_000, Math.min(wait, 6 * 3_600_000)),
    );
    return () => clearTimeout(timer);
  }, [search.day, today, zone]);
  return (
    <TodayPage
      day={search.day ?? today}
      zone={zone}
      dayGiven={search.day !== undefined}
      onChange={(next) => {
        const day = next.day ?? search.day;
        const tz = next.zone ?? search.tz;
        void navigate({
          to: "/today",
          search: { ...(day ? { day } : {}), ...(tz ? { tz } : {}) },
          replace: true,
        });
      }}
    />
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
  const matchRoute = useMatchRoute();
  const selected = matchRoute({ to: "/tasks/$taskId", fuzzy: true });
  const child =
    selected !== false || matchRoute({ to: "/tasks/new" }) !== false;
  return (
    <div className="flex flex-col gap-6 desktop:flex-row" data-tasks-layout="">
      <aside
        className={`${child ? "hidden desktop:block" : "block"} desktop:w-[300px]`}
      >
        {child ? null : <PageHeading>{TASKS_TITLE}</PageHeading>}
        <div className={child ? "" : "mt-4"}>
          <TaskList
            selected={
              selected === false
                ? undefined
                : (selected as { taskId: string }).taskId
            }
          />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
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
