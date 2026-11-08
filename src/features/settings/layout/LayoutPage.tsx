import { Link } from "@tanstack/react-router";
import { useId } from "react";
import {
  type TaskWrapper,
  useTaskWrapper,
  writeTaskWrapper,
} from "../../../app/shell/preferences";
import { GroupedBox } from "../../../components/ui/grouped";
import { PageHeading } from "../../../components/ui/page-heading";
import { cn } from "../../../lib/utils";

/** Settings · Layout (the Final design): how a task opens from a list. Copy from the frame "Setting · how tasks open". */
export const LAYOUT_COPY = {
  eyebrow: "Settings · Layout",
  title: "How things open",
  lead: "Pick what happens when you open a task, a person or a list. The thing itself looks the same in all four; only the container changes. You can switch any time.",
  legend: "How things open",
  options: {
    page: {
      label: "Full page",
      line: "The task replaces the list. Back returns to it.",
    },
    split: {
      label: "Split pane",
      line: "The list stays on the left, the task fills the right.",
    },
    peek: {
      label: "Side peek",
      line: "A floating panel over the list; ↑↓ moves between tasks.",
    },
    overlay: {
      label: "Overlay",
      line: "Centred over a dimmed list. Esc closes.",
    },
  } satisfies Record<TaskWrapper, { label: string; line: string }>,
  alsoHeading: "Also applies to",
  also: [
    { what: "Creating a task", how: "same container as opening one" },
    {
      what: "A task in a list, or in all the tasks",
      how: "the same container",
    },
    { what: "People and lists", how: "beside their lists, in the same way" },
    { what: "On the phone", how: "always full page" },
  ],
  narrow:
    "A split pane needs a wide screen; below it the task opens as a page.",
  saved: "Saved for this browser only.",
  back: "Settings",
} as const;

/** The small sketch in each card: where the list and the task sit. Decorative. */
function Sketch({ kind }: { kind: TaskWrapper }) {
  const list = (
    <span className="absolute left-2 top-2 flex w-[42%] flex-col gap-1">
      {[0, 1, 2, 3, 4].map((n) => (
        <span key={n} className="h-1.5 rounded-sm bg-border" />
      ))}
    </span>
  );
  const task = (className: string) => (
    <span
      className={cn(
        "absolute flex flex-col gap-1 rounded-[5px] border border-border bg-card p-1.5",
        className,
      )}
    >
      <span className="h-2 w-3/5 rounded-sm bg-muted-foreground/60" />
      <span className="h-1 w-11/12 rounded-sm bg-border" />
      <span className="h-3 w-full rounded-sm border border-border" />
    </span>
  );
  return (
    <span
      aria-hidden="true"
      className="relative block h-[88px] w-full overflow-hidden rounded-lg border border-border bg-background"
    >
      {kind === "page" ? task("inset-2") : null}
      {kind === "split" ? (
        <>
          {list}
          <span className="absolute inset-y-0 left-[48%] w-px bg-border" />
          {task("left-[52%] right-2 top-2 bottom-2")}
        </>
      ) : null}
      {kind === "peek" ? (
        <>
          <span className="opacity-50">{list}</span>
          {task("right-1.5 top-1.5 bottom-1.5 w-[46%] shadow-lg")}
        </>
      ) : null}
      {kind === "overlay" ? (
        <>
          <span className="opacity-35">{list}</span>
          {task(
            "left-1/2 top-1/2 h-[60%] w-[64%] -translate-x-1/2 -translate-y-1/2 shadow-lg",
          )}
        </>
      ) : null}
    </span>
  );
}

export function LayoutPage() {
  const wrapper = useTaskWrapper();
  const id = useId();
  return (
    <div className="atlas-enter flex flex-col gap-6" data-layout-page="">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground hover:text-foreground"
        >
          {LAYOUT_COPY.back}
        </Link>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-primary">
          {LAYOUT_COPY.eyebrow}
        </p>
        <PageHeading>{LAYOUT_COPY.title}</PageHeading>
        <p className="max-w-[640px] text-[15px] text-muted-foreground">
          {LAYOUT_COPY.lead}
        </p>
      </div>
      <fieldset className="m-0 flex max-w-[1100px] flex-col gap-3 border-0 p-0">
        <legend className="sr-only">{LAYOUT_COPY.legend}</legend>
        <div className="grid gap-3.5 tablet:grid-cols-2 desktop:grid-cols-4">
          {(Object.keys(LAYOUT_COPY.options) as TaskWrapper[]).map((kind) => {
            const option = LAYOUT_COPY.options[kind];
            const checked = wrapper === kind;
            return (
              <label
                key={kind}
                className={cn(
                  "atlas-transition flex cursor-pointer flex-col gap-3 rounded-[14px] border p-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  checked
                    ? "border-primary bg-accent/50"
                    : "border-border bg-card hover:bg-accent/30",
                )}
                data-task-wrapper-option={kind}
              >
                <span className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name={id}
                    value={kind}
                    checked={checked}
                    onChange={() => writeTaskWrapper(kind)}
                    aria-labelledby={`${id}-${kind}-label`}
                    aria-describedby={`${id}-${kind}`}
                    className="size-[18px]"
                  />
                  <span
                    id={`${id}-${kind}-label`}
                    className="font-semibold text-foreground"
                  >
                    {option.label}
                  </span>
                </span>
                <Sketch kind={kind} />
                <span
                  id={`${id}-${kind}`}
                  className="text-xs text-muted-foreground"
                >
                  {option.line}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex max-w-[1100px] flex-col gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {LAYOUT_COPY.alsoHeading}
        </h2>
        <GroupedBox data-layout-also="">
          {LAYOUT_COPY.also.map((row) => (
            <div
              key={row.what}
              className="flex min-h-12 items-center gap-4 px-4 text-sm tablet:px-5"
            >
              <span className="flex-1 text-foreground">{row.what}</span>
              <span className="text-[13px] text-muted-foreground">
                {row.how}
              </span>
            </div>
          ))}
        </GroupedBox>
        <p className="text-xs text-muted-foreground">
          {LAYOUT_COPY.narrow} {LAYOUT_COPY.saved}
        </p>
      </div>
    </div>
  );
}
