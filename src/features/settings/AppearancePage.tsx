import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { PageHeading } from "../../components/ui/page-heading";
import { RadioCardGroup } from "../../components/ui/radio-card-group";
import { useTheme } from "../../design/ThemeProvider";
import type { AppearancePreference } from "../../design/theme";

/** WF-SETTINGS-05. The stored value is "auto"; the accepted design labels it "Match system". */
export const OPTIONS = [
  {
    value: "dark",
    label: "Dark",
    contractId: "appearance-dark",
    preview: <Preview kind="dark" />,
  },
  {
    value: "light",
    label: "Light",
    contractId: "appearance-light",
    preview: <Preview kind="light" />,
  },
  {
    value: "auto",
    label: "Match system",
    contractId: "appearance-auto",
    preview: <Preview kind="auto" />,
  },
] as const;

export const APPEARANCE_COPY = {
  back: "Settings",
  eyebrow: "Settings · Appearance",
  title: "Appearance",
  lead: "Dark, light, or whatever the device prefers.",
  unsaved:
    "This browser can't save your choice, so it will reset when you reload.",
  local:
    "Saved for this browser only, so a shared computer doesn't inherit your choice.",
} as const;

function Preview({ kind }: { kind: "dark" | "light" | "auto" }) {
  // Fixed colours by design: a preview of a theme shows that theme whatever theme is active. See base.css.
  if (kind === "auto") {
    return (
      <span className="appearance-preview appearance-preview--split">
        <span data-half="dark" />
        <span data-half="light" />
      </span>
    );
  }
  return (
    <span className="appearance-preview" data-preview={kind}>
      <i />
      <b />
    </span>
  );
}

/**
 * Settings · Appearance, a page of its own under `/settings/appearance` (every Settings section opens the same way, the review of
 * 8 November 2026): the three choices as cards, the selected one taking the focus when the page opens (B15), and what the choice
 * means for this browser.
 */
export function AppearancePage() {
  const { preference, setPreference, persisted } = useTheme();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>('[role="radio"][data-state="checked"]')
      ?.focus();
  }, []);
  return (
    <div
      ref={root}
      className="atlas-enter flex flex-col gap-6"
      data-appearance-page=""
    >
      <div className="flex flex-col gap-2">
        <Link
          to="/settings"
          className="atlas-transition inline-flex min-h-11 w-fit items-center text-sm text-muted-foreground hover:text-foreground"
        >
          {APPEARANCE_COPY.back}
        </Link>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-primary">
          {APPEARANCE_COPY.eyebrow}
        </p>
        <PageHeading>{APPEARANCE_COPY.title}</PageHeading>
        <p className="max-w-[640px] text-[15px] text-muted-foreground">
          {APPEARANCE_COPY.lead}
        </p>
      </div>
      <div className="flex max-w-[720px] flex-col gap-4">
        <RadioCardGroup<AppearancePreference>
          label="Theme"
          value={preference}
          onValueChange={setPreference}
          options={OPTIONS}
        />
        {persisted ? null : (
          <p className="rounded-lg border border-warning/30 bg-warning/12 px-3.5 py-3 text-xs leading-relaxed text-foreground">
            {APPEARANCE_COPY.unsaved}
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {APPEARANCE_COPY.local}
        </p>
      </div>
    </div>
  );
}
