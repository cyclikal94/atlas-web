import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { useOptionalDataEnv } from "../../data";
import { CacheGate } from "../sync/CacheGate";
import { TASKS_TITLE } from "./titles";

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
  if (useOptionalDataEnv() === null)
    return <PageHeading>{TASKS_TITLE}</PageHeading>;
  return (
    <CacheGate>
      <Suspense fallback={null}>
        <TasksLayoutScreen />
      </Suspense>
    </CacheGate>
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
