import {
  CalendarCheck,
  ListChecks,
  type LucideIcon,
  Settings,
  Share2,
  Users,
} from "lucide-react";

export type DestinationId =
  | "today"
  | "tasks"
  | "people"
  | "sharing"
  | "settings";

export interface Destination {
  id: DestinationId;
  /** Generic destination name: also used for the tab title, so it never carries account data. */
  label: string;
  to: string;
  icon: LucideIcon;
  /** Today, Tasks and People are tabs on mobile; Sharing and Settings sit in the More sheet. */
  mobile: "tab" | "more";
  /** Desktop rail group: two groups split by a divider. */
  group: 1 | 2;
}

export const destinations: readonly Destination[] = [
  {
    id: "today",
    label: "Today",
    to: "/today",
    icon: CalendarCheck,
    mobile: "tab",
    group: 1,
  },
  {
    id: "tasks",
    label: "Tasks",
    to: "/tasks",
    icon: ListChecks,
    mobile: "tab",
    group: 1,
  },
  {
    id: "people",
    label: "People",
    to: "/people",
    icon: Users,
    mobile: "tab",
    group: 1,
  },
  {
    id: "sharing",
    label: "Sharing",
    to: "/sharing",
    icon: Share2,
    mobile: "more",
    group: 2,
  },
  {
    id: "settings",
    label: "Settings",
    to: "/settings",
    icon: Settings,
    mobile: "more",
    group: 2,
  },
];

/** The destination a pathname belongs to, or undefined for an unknown path. */
export function destinationFor(pathname: string): Destination | undefined {
  return destinations.find(
    (d) => pathname === d.to || pathname.startsWith(`${d.to}/`),
  );
}
