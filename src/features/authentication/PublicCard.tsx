import { type ReactNode, useEffect, useRef } from "react";
import { AtlasMark } from "../../components/ui/brand";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { NeutralStatus } from "../../components/ui/neutral-status";
import { authFeedback, type FeedbackItem } from "./feedback";
import { MessageText } from "./MessageText";
import {
  ENDED_BANNER,
  LOCK_WAIT_BANNER,
  SUPERSEDED_BANNER,
} from "./outcome-copy";

/**
 * The frame of the public surfaces (sign-in and join): a centred card, the Atlas mark, a heading. It shows nothing about any
 * account and imports nothing from the session or the gate. The heading is the programmatic focus target, focused when the
 * page appears and again when `focusKey` changes (a new state of the same page).
 */
export function PublicCard({
  heading,
  focusKey,
  focus = true,
  surface,
  banners,
  children,
}: {
  heading: ReactNode;
  focusKey: string;
  /** False while the heading is only a skeleton: nothing to read yet, so focus waits for the real heading. */
  focus?: boolean;
  surface: "sign-in" | "join";
  banners?: ReactNode;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus is meant to follow the state key
  useEffect(() => {
    if (focus) headingRef.current?.focus();
  }, [focusKey, focus]);
  return (
    <main
      data-public-surface={surface}
      className="atlas-enter mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center gap-4 px-4 py-10"
    >
      {banners}
      <Card className="gap-6 px-6 py-6 tablet:px-8 tablet:py-8">
        <div className="flex flex-col gap-4">
          <span className="flex items-center gap-3">
            <AtlasMark size="lg" />
            <span className="text-base font-semibold tracking-tight text-foreground">
              Atlas
            </span>
          </span>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold leading-tight tracking-tight text-foreground"
          >
            {heading}
          </h1>
        </div>
        {children}
      </Card>
    </main>
  );
}

/** What a 1c fact looks like above a form: the accepted card wording, dismissible, announced once when it appears. */
export function FeedbackBanners({ items }: { items: readonly FeedbackItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          data-feedback={item.kind}
          className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 shadow-sm"
        >
          <NeutralStatus kind="status">
            {item.kind === "superseded" ? (
              <>
                <strong className="font-medium">
                  {SUPERSEDED_BANNER.heading}.
                </strong>{" "}
                {SUPERSEDED_BANNER.message}
              </>
            ) : item.kind === "lock_wait" ? (
              <>
                <strong className="font-medium">
                  {LOCK_WAIT_BANNER.heading}.
                </strong>{" "}
                {LOCK_WAIT_BANNER.message}
              </>
            ) : item.kind === "ended" ? (
              <>
                <strong className="font-medium">{ENDED_BANNER.heading}.</strong>{" "}
                {ENDED_BANNER.message}
              </>
            ) : (
              <MessageText message={item.message} />
            )}
          </NeutralStatus>
          <Button variant="ghost" onClick={() => authFeedback.dismiss(item.id)}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
