import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useShellEnv } from "../../../app/shell/env";
import { List } from "../../../components/ui/list";
import { PageHeading } from "../../../components/ui/page-heading";
import { yourDataSlots } from "./slots";

/**
 * WF-SETTINGS-06, "Your data". Copy is verbatim from `settings-06-desktop.html`. The wireframe tags each block with the slice
 * that owns it; those tags are here, in comments, and never rendered: the blocks below are owner WEB-08, and the
 * `calendarLine` slot is owner WEB-13 (see `slots.ts`). No request is made: the only live value is the count of items
 * waiting to send, which the shell already holds.
 */
export const HOLDING_ROWS: ReadonlyArray<{ label: string; detail: string }> = [
  {
    label: "A copy of what you can see",
    detail: "So Atlas works without a connection",
  },
  // The second row's detail is the live pending count and is built in the component.
  { label: "Anything waiting to send", detail: "" },
  { label: "Your appearance choice", detail: "This browser only" },
];

export const WORTH_KNOWING: readonly string[] = [
  "If someone stops sharing something with you, this device clears it the next time it connects — not the moment they change it.",
  "Something you recorded and haven't sent yet is never removed by that. Your own work is yours.",
];

export const CANT_DO_YET =
  "There's no download-my-data button in this release — exports are run by an administrator for the whole system. There's no clear-local-data button either; retiring this device in Sessions & devices is the nearest thing.";

export const pendingDetail = (count: number): string =>
  `${count} ${count === 1 ? "item" : "items"} right now`;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex max-w-[700px] flex-col gap-2.5">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function YourData() {
  const { syncModel } = useShellEnv();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground hover:text-foreground"
        >
          Settings
        </Link>
        <PageHeading>Your data</PageHeading>
      </div>

      {/* owner: WEB-08 */}
      <Block title="What this device is holding">
        <List className="flex flex-col">
          {HOLDING_ROWS.map((row, index) => (
            <li
              key={row.label}
              className="flex flex-col gap-1 border-t border-border px-0.5 py-3 tablet:flex-row tablet:items-center tablet:gap-3"
            >
              <span className="text-sm text-foreground tablet:w-[220px] tablet:flex-none">
                {row.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {index === 1
                  ? pendingDetail(syncModel.pendingCount)
                  : row.detail}
              </span>
            </li>
          ))}
        </List>
      </Block>

      {/* owner: WEB-08 */}
      <Block title="Two things worth knowing">
        <List className="flex flex-col gap-2.5">
          {WORTH_KNOWING.map((line) => (
            <li
              key={line}
              className="list-none rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground"
            >
              {line}
            </li>
          ))}
        </List>
      </Block>

      {/* owner: WEB-08 */}
      <Block title="Things Atlas can't do yet">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {CANT_DO_YET}
        </p>
        {/* owner: WEB-13 - the named slot */}
        <p
          data-slot="calendarLine"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {yourDataSlots.calendarLine}
        </p>
      </Block>
    </div>
  );
}
