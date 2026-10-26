import { Link } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronRight,
  Database,
  KeyRound,
  type LucideIcon,
  MonitorSmartphone,
  Settings2,
  SunMoon,
} from "lucide-react";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import { AccountCard } from "./account/AccountCard";
import { useOpenedByLink } from "./focus";
import { sectionPath, settingsSections } from "./sections";

/**
 * WF-SETTINGS-01: the account card (WEB-08b), then the list, rendered from the registry (plan 8.3). The descriptions are static:
 * they need no request, so the list paints at once and only the account card shows a skeleton.
 */
/** A decorative glyph per section; a section the registry adds later falls back to the generic one. */
const ICONS: Record<string, LucideIcon> = {
  "signing-in": KeyRound,
  sessions: MonitorSmartphone,
  appearance: SunMoon,
  calendars: CalendarDays,
  data: Database,
};

export function SettingsHome() {
  const openedByLink = useOpenedByLink();
  return (
    <div className="atlas-enter flex max-w-[620px] flex-col gap-3 tablet:gap-5">
      <PageHeading>Settings</PageHeading>
      <AccountCard />
      <List className="atlas-stagger overflow-hidden rounded-xl border bg-card p-0.5 shadow-sm tablet:p-1">
        {settingsSections().map((section) => {
          const Icon = ICONS[section.id] ?? Settings2;
          return (
            <li key={section.id} className="list-none">
              <Link
                to={sectionPath(section)}
                data-settings-link={section.id}
                aria-labelledby={`settings-${section.id}-label`}
                aria-describedby={`settings-${section.id}-description`}
                onClick={() => {
                  openedByLink.current = true;
                }}
                className="atlas-transition group flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-1 text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <span
                  aria-hidden="true"
                  className="atlas-transition hidden size-8 flex-none items-center justify-center rounded-md border bg-secondary text-muted-foreground group-hover:border-primary/25 group-hover:bg-background group-hover:text-primary tablet:flex"
                >
                  <Icon className="size-4" strokeWidth={1.9} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    id={`settings-${section.id}-label`}
                    className="font-medium"
                  >
                    {section.label}
                  </span>
                  <span
                    id={`settings-${section.id}-description`}
                    className="truncate text-xs text-muted-foreground tablet:whitespace-normal"
                  >
                    {section.description}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  size={16}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Link>
            </li>
          );
        })}
      </List>
    </div>
  );
}
