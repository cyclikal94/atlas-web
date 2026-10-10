import * as RadioGroup from "@radix-ui/react-radio-group";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { type SharingResult, untilSent } from "./api";
import { REQUEST_ID } from "./copy";

/**
 * Small pieces shared by WEB-12a's sharing screens. Announcements go only through the existing announcer (lint R6: no live region here).
 */

/** An error or notice banner: the message, a copyable request ID when the server gave one, and its own action (the Er states). */
export function Banner({
  message,
  requestId,
  action,
  tone = "error",
  announce = true,
}: {
  message: string;
  requestId?: string | undefined;
  action?: ReactNode;
  tone?: "error" | "note";
  announce?: boolean;
}) {
  const announcer = useAnnouncer();
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per message, not per announcer identity
  useEffect(() => {
    if (announce && tone === "error") announcer.announce(message, "assertive");
  }, [message]);
  return (
    <div
      data-sharing-banner={tone}
      className="flex flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <p className="text-[13.5px] leading-[1.55] text-ink-1">{message}</p>
      {requestId ? (
        <p className="font-num select-all text-[12px] text-ink-2">
          {REQUEST_ID(requestId)}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export interface Choice<Value extends string> {
  value: Value;
  label: string;
}

/**
 * A labelled radio group (accessibility.md 1.5: role radiogroup, roving tabindex, arrows move and select). Each option is at least 44 px
 * high, and the state is never colour alone (a ring holds a dot when selected).
 */
export function ChoiceGroup<Value extends string>({
  label,
  value,
  onChange,
  choices,
  disabled = false,
  orientation = "horizontal",
  name,
}: {
  label: string;
  value: Value | null;
  onChange(value: Value): void;
  choices: readonly Choice<Value>[];
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
  name?: string;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value ?? ""}
      onValueChange={(next) => onChange(next as Value)}
      disabled={disabled}
      orientation={orientation}
      {...(name ? { name } : {})}
      className={`flex gap-1.5 ${orientation === "vertical" ? "flex-col" : "flex-row flex-wrap"}`}
    >
      {choices.map((choice) => (
        <RadioGroup.Item
          key={choice.value}
          value={choice.value}
          className="atlas-transition flex min-h-11 items-center gap-2 rounded-control border border-hairline-strong bg-canvas px-3 text-left text-[13px] text-ink-1 hover:border-field-edge disabled:opacity-60 data-[state=checked]:border-action-fill"
        >
          <span
            aria-hidden="true"
            className="flex size-[15px] flex-none items-center justify-center rounded-round border-[1.5px] border-field-edge"
          >
            <RadioGroup.Indicator className="size-[7px] rounded-round bg-action-fill" />
          </span>
          <span>{choice.label}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

export type Load<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: T; at: number }
  | { status: "failed"; failure: Extract<SharingResult<T>, { ok: false }> };

/**
 * One online read with its own loading and error states. A `not_sent` is asked again quietly (bounded); a stale answer never overwrites a
 * newer one, and nothing is set after unmount. Nothing is read until `enabled` (offline at open: nothing stale is shown).
 */
export function useSharingLoad<T>(
  read: () => Promise<SharingResult<T>>,
  options: { enabled: boolean; now(): number },
): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "idle" });
  const generation = useRef(0);
  const reader = useRef(read);
  reader.current = read;
  const now = useRef(options.now);
  now.current = options.now;
  const run = useCallback(() => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    void untilSent(() => reader.current(), {
      isCurrent: () => mine === generation.current,
    }).then(
      (result) => {
        if (mine !== generation.current) return;
        setState(
          result.ok
            ? { status: "ready", value: result.value, at: now.current() }
            : { status: "failed", failure: result },
        );
      },
      () => {
        if (mine !== generation.current) return;
        setState({
          status: "failed",
          failure: { ok: false, kind: "uncertain" },
        });
      },
    );
  }, []);
  // The first time it is enabled it reads; losing the connection later keeps what was read (an editor keeps its draft), and only an
  // explicit reload reads again.
  const started = useRef(false);
  useEffect(() => {
    if (options.enabled && !started.current) {
      started.current = true;
      run();
    }
  }, [options.enabled, run]);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return [state, run];
}

/** "12:04" today, "3 Oct, 12:04" another day. UK English, 24-hour. */
export function formatWhen(at: number, now: number): string {
  const when = new Date(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(when);
  if (when.toDateString() === new Date(now).toDateString()) return `at ${time}`;
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(when);
  return `on ${day} at ${time}`;
}

export function RetryButton({
  onClick,
  children,
}: {
  onClick(): void;
  children: ReactNode;
}) {
  return <Button onClick={onClick}>{children}</Button>;
}
