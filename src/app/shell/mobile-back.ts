/**
 * The phone's back affordance (the Final design, 8 November 2026): a detail screen replaces the brand in the header with a way back
 * to its list and hides the tab bar (`AppShell` `mobileBack`). Derived from the address alone, so every detail screen gets it without
 * naming it, and a screen's own "‹ Tasks" link is for the wider layouts (where the list stays beside it).
 */
export interface MobileBack {
  label: string;
  to: string;
}

const UUID = "[0-9a-f-]{8,}";
const rules: ReadonlyArray<{
  pattern: RegExp;
  back: (m: RegExpExecArray) => MobileBack;
}> = [
  {
    pattern: /^\/focus\/?$/,
    back: () => ({ label: "Today", to: "/today" }),
  },
  {
    pattern: /^\/tasks\/new\/?$/,
    back: () => ({ label: "Tasks", to: "/tasks" }),
  },
  {
    pattern: /^\/tasks\/timers\/?$/,
    back: () => ({ label: "Tasks", to: "/tasks" }),
  },
  {
    pattern: new RegExp(`^/tasks/lists/(${UUID})/?$`),
    back: () => ({ label: "Lists", to: "/tasks/lists" }),
  },
  {
    pattern: new RegExp(`^/tasks/(${UUID})/(edit|streak)/?$`),
    back: (m) => ({ label: "Task", to: `/tasks/${m[1]}` }),
  },
  {
    pattern: new RegExp(`^/tasks/(${UUID})/?$`),
    back: () => ({ label: "Tasks", to: "/tasks" }),
  },
  {
    pattern: /^\/people\/requests\/?$/,
    back: () => ({ label: "People", to: "/people" }),
  },
  {
    pattern: /^\/people\/requests\/[^/]+\/?$/,
    back: () => ({ label: "Requests", to: "/people/requests" }),
  },
  {
    pattern: /^\/people\/merge\/.+$/,
    back: () => ({ label: "People", to: "/people" }),
  },
  {
    pattern: new RegExp(`^/people/(${UUID})/(fields|duplicates)(/.*)?$`),
    back: (m) => ({ label: "Person", to: `/people/${m[1]}` }),
  },
  {
    pattern: new RegExp(`^/people/(${UUID})/?$`),
    back: () => ({ label: "People", to: "/people" }),
  },
  {
    pattern: /^\/sharing\/(defaults|items)(\/.*)?$/,
    back: () => ({ label: "Sharing", to: "/sharing" }),
  },
];

/** The back affordance for a path, or `undefined` for a top-level screen (which keeps the brand and the tabs). */
export function mobileBackFor(pathname: string): MobileBack | undefined {
  for (const rule of rules) {
    const match = rule.pattern.exec(pathname);
    if (match !== null) return rule.back(match);
  }
  return undefined;
}
