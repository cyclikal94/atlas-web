import { Link } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronRight,
  Database,
  KeyRound,
  LayoutPanelLeft,
  type LucideIcon,
  MonitorSmartphone,
  Settings2,
  SunMoon,
} from "lucide-react";
import { List } from "../../components/ui/list";
import { Eyebrow, PageHeader } from "../../components/ui/page-header";
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
  layout: LayoutPanelLeft,
  calendars: CalendarDays,
  data: Database,
};

export function SettingsHome() {
  const openedByLink = useOpenedByLink();
  return (
    <div className="atlas-enter flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow={<Eyebrow>Settings</Eyebrow>}
        title={<PageHeading>Settings</PageHeading>}
        summary="Your account, this device and how Atlas looks and behaves."
      />
      <AccountCard />
      <List className="atlas-stagger flex flex-col">
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
                className="atlas-transition group -mx-3.5 flex min-h-[52px] items-center gap-3.5 rounded-[10px] px-3.5 text-[15px] text-foreground hover:bg-accent/60"
              >
                <span
                  aria-hidden="true"
                  className="atlas-transition flex size-8 flex-none items-center justify-center rounded-full bg-accent text-muted-foreground group-hover:text-primary"
                >
                  <Icon className="size-4" strokeWidth={1.9} />
                </span>
                <span
                  id={`settings-${section.id}-label`}
                  className="min-w-0 flex-1 truncate"
                >
                  {section.label}
                </span>
                <span
                  id={`settings-${section.id}-description`}
                  className="hidden min-w-0 shrink truncate text-xs text-muted-foreground tablet:inline"
                >
                  {section.description}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  size={16}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              </Link>
            </li>
          );
        })}
      </List>
    </div>
  );
}
