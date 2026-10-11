import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { List } from "../../components/ui/list";
import { PageHeading } from "../../components/ui/page-heading";
import { AccountCard } from "./account/AccountCard";
import { useOpenedByLink } from "./focus";
import { sectionPath, settingsSections } from "./sections";

/**
 * WF-SETTINGS-01: the account card (WEB-08b), then the list, rendered from the registry (plan 8.3). The descriptions are static:
 * they need no request, so the list paints at once and only the account card shows a skeleton.
 */
export function SettingsHome() {
  const openedByLink = useOpenedByLink();
  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <PageHeading>Settings</PageHeading>
      <AccountCard />
      <List className="flex flex-col gap-2">
        {settingsSections().map((section) => (
          <li key={section.id} className="list-none">
            <Link
              to={sectionPath(section)}
              data-settings-link={section.id}
              aria-labelledby={`settings-${section.id}-label`}
              aria-describedby={`settings-${section.id}-description`}
              onClick={() => {
                openedByLink.current = true;
              }}
              className="atlas-transition flex min-h-12 items-center justify-between gap-3 rounded-row border border-hairline-strong bg-panel px-4 py-2 text-[14px] text-ink-1 hover:bg-row-hover"
            >
              <span className="flex flex-col">
                <span id={`settings-${section.id}-label`}>{section.label}</span>
                <span
                  id={`settings-${section.id}-description`}
                  className="text-[12.5px] text-ink-2"
                >
                  {section.description}
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                size={16}
                className="shrink-0 text-ink-2"
              />
            </Link>
          </li>
        ))}
      </List>
    </div>
  );
}
