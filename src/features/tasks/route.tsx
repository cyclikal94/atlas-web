import {
  type AnyRoute,
  createRoute,
  useMatchRoute,
} from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { LISTS_TITLE, TASKS_TITLE } from "./titles";

const screens = () => import("./screens");
const TasksLayoutScreen = lazy(() =>
  screens().then((m) => ({ default: m.TasksLayoutScreen })),
);
const TaskDetailScreen = lazy(() =>
  screens().then((m) => ({ default: m.TaskDetailScreen })),
);
const TaskNewScreen = lazy(() =>
  screens().then((m) => ({ default: m.TaskNewScreen })),
);
const TaskEditScreen = lazy(() =>
  screens().then((m) => ({ default: m.TaskEditScreen })),
);
const ListsLayoutScreen = lazy(() =>
  screens().then((m) => ({ default: m.ListsLayoutScreen })),
);

/** `/tasks/<id>?occurrence=<id>`: a task, optionally one of its days (the public path helper for WEB-10b/10c/14b). */
export const taskPath = (taskId: string, occurrence?: string): string =>
  `/tasks/${encodeURIComponent(taskId)}${occurrence ? `?occurrence=${encodeURIComponent(occurrence)}` : ""}`;

export interface TaskSearch {
  occurrence?: string;
  record?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The Tasks routes (§4.5): `/tasks` (the list), `/tasks/new` (the preset picker, then the form), `/tasks/$taskId` (the detail) and
 * `/tasks/$taskId/edit`. The screens are one lazy chunk (`screens.tsx`).
 */
function TasksLayout() {
  const matchRoute = useMatchRoute();
  return (
    <Gated
      title={TASKS_TITLE}
      child={
        matchRoute({ to: "/tasks/$taskId", fuzzy: true }) !== false ||
        matchRoute({ to: "/tasks/new" }) !== false
      }
    >
      <TasksLayoutScreen />
    </Gated>
  );
}

/**
 * A destination's layout behind the cache gate. The list's heading is the route's, outside the cache gate and the lazy screens (revision 2),
 * so it exists at once and in every gate state; a child page (a task, a list) has its own heading, and while the gate hides it the gate
 * shows the list's.
 */
function Gated({
  title,
  child,
  children,
}: {
  title: string;
  child: boolean;
  children: ReactNode;
}) {
  const heading = <PageHeading>{title}</PageHeading>;
  if (useOptionalDataEnv() === null) return heading;
  return (
    <>
      {child ? null : heading}
      <CacheGate heading={child ? heading : null}>
        <Suspense fallback={null}>{children}</Suspense>
      </CacheGate>
    </>
  );
}

/** WEB-10b's Lists (`/tasks/lists`, `/tasks/lists/$listId`): under the Tasks destination (D-10b-1), with a heading of its own. */
function ListsLayout() {
  const matchRoute = useMatchRoute();
  return (
    <Gated
      title={LISTS_TITLE}
      child={matchRoute({ to: "/tasks/lists/$listId" }) !== false}
    >
      <ListsLayoutScreen />
    </Gated>
  );
}

export const tasksRoute = (parent: AnyRoute) => {
  const tasks = createRoute({
    getParentRoute: () => parent,
    path: "tasks",
    component: TasksLayout,
  });
  const index = createRoute({ getParentRoute: () => tasks, path: "/" });
  const create = createRoute({
    getParentRoute: () => tasks,
    path: "new",
    component: () => (
      <Suspense fallback={null}>
        <TaskNewScreen />
      </Suspense>
    ),
  });
  const detail = createRoute({
    getParentRoute: () => tasks,
    path: "$taskId",
    validateSearch: (search: Record<string, unknown>): TaskSearch => ({
      ...(typeof search.occurrence === "string" && UUID.test(search.occurrence)
        ? { occurrence: search.occurrence }
        : {}),
      ...(search.record === true || search.record === "true"
        ? { record: true }
        : {}),
    }),
  });
  const view = createRoute({
    getParentRoute: () => detail,
    path: "/",
    component: function DetailRoute() {
      const { taskId } = detail.useParams();
      const search = detail.useSearch();
      return (
        <Suspense fallback={null}>
          <TaskDetailScreen
            taskId={taskId}
            {...(search.occurrence ? { occurrence: search.occurrence } : {})}
            {...(search.record ? { record: true } : {})}
          />
        </Suspense>
      );
    },
  });
  const edit = createRoute({
    getParentRoute: () => detail,
    path: "edit",
    component: function EditRoute() {
      const { taskId } = detail.useParams();
      return (
        <Suspense fallback={null}>
          <TaskEditScreen taskId={taskId} />
        </Suspense>
      );
    },
  });
  return tasks.addChildren([index, create, detail.addChildren([view, edit])]);
};

/**
 * The Lists routes (WEB-10b, D-10b-1): a root-level branch whose path starts `tasks/lists`, so the Tasks destination stays highlighted and
 * titled; its static segment outranks `/tasks/$taskId`. The screens are in the same lazy chunk as the task screens.
 */
export const listsRoute = (parent: AnyRoute) => {
  const lists = createRoute({
    getParentRoute: () => parent,
    path: "tasks/lists",
    component: ListsLayout,
  });
  // The detail is drawn by the lazy layout from the matched id (no second lazy screen in the routes' first load).
  const index = createRoute({ getParentRoute: () => lists, path: "/" });
  const detail = createRoute({ getParentRoute: () => lists, path: "$listId" });
  return lists.addChildren([index, detail]);
};
