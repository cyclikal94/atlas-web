import {
  CalendarCheck,
  CalendarDays,
  CalendarRange,
  ListChecks,
  ListTodo,
  type LucideIcon,
  Settings,
  Share2,
  Users,
} from "lucide-react";

export type DestinationId =
  | "today"
  | "upcoming"
  | "calendar"
  | "people"
  | "lists"
  | "tasks"
  | "sharing"
  | "settings";

export interface Destination {
  id: DestinationId;
  /** Generic destination name: also the tab title and the phone tab, so it never carries account data. */
  label: string;
  /** The sidebar's wording where it differs from the tab's ("All lists" under Pinned lists). */
  railLabel?: string;
  /** The document title where it differs from the label (the page's own heading: "Tasks" for All tasks). */
  title?: string;
  to: string;
  icon: LucideIcon;
  /** Today, Upcoming, Calendar, People and Lists are tabs on the phone; the rest sit in the More sheet. */
  mobile: "tab" | "more";
  /** Sidebar group: the day views, the lists, then the household and settings. */
  group: "main" | "lists" | "system";
}

export const destinations: readonly Destination[] = [
  {
    id: "today",
    label: "Today",
    to: "/today",
    icon: CalendarCheck,
    mobile: "tab",
    group: "main",
  },
  {
    id: "upcoming",
    label: "Upcoming",
    to: "/upcoming",
    icon: CalendarRange,
    mobile: "tab",
    group: "main",
  },
  {
    id: "calendar",
    label: "Calendar",
    to: "/calendar",
    icon: CalendarDays,
    mobile: "tab",
    group: "main",
  },
  {
    id: "people",
    label: "People",
    to: "/people",
    icon: Users,
    mobile: "tab",
    group: "main",
  },
  {
    id: "lists",
    label: "Lists",
    railLabel: "All lists",
    to: "/tasks/lists",
    icon: ListTodo,
    mobile: "tab",
    group: "lists",
  },
  {
    id: "tasks",
    label: "All tasks",
    title: "Tasks",
    to: "/tasks",
    icon: ListChecks,
    mobile: "more",
    group: "lists",
  },
  {
    id: "sharing",
    label: "Sharing",
    to: "/sharing",
    icon: Share2,
    mobile: "more",
    group: "system",
  },
  {
    id: "settings",
    label: "Settings",
    to: "/settings",
    icon: Settings,
    mobile: "more",
    group: "system",
  },
];

/** The destination a pathname belongs to (the longest matching path, so `/tasks/lists` is Lists, not All tasks), or undefined. */
export function destinationFor(pathname: string): Destination | undefined {
  let best: Destination | undefined;
  for (const d of destinations)
    if (
      (pathname === d.to || pathname.startsWith(`${d.to}/`)) &&
      (best === undefined || d.to.length > best.to.length)
    )
      best = d;
  return best;
}
