import * as RadioGroup from "@radix-ui/react-radio-group";
import { type ReactNode, useCallback, useEffect } from "react";
import { useAnnouncer } from "../../components/ui/announcer";
import {
  type EditOutcome,
  type EnqueueOutcome,
  type Outbox,
  type SupersedeOutcome,
  useDataEnv,
} from "../../data";
import * as copy from "./copy";
import type { PendingMark } from "./model/project";

/**
 * Small pieces shared by the people screens. Announcements go only through the existing announcer (lint R6: no live region here).
 */

/** An error or notice banner: the message, a copyable reference when the server gave one, and its own action (the Er states). */
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
      data-people-banner={tone}
      className="flex flex-col items-start gap-2 rounded-row border border-hairline-strong bg-panel p-3.5"
    >
      <p className="text-[13.5px] leading-[1.55] text-ink-1">{message}</p>
      {requestId ? (
        <p className="font-num select-all text-[12px] text-ink-2">
          Reference: {requestId}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export interface Choice<Value extends string> {
  value: Value;
  label: string;
  description?: string;
  /** A choice that cannot be made now, with the reason shown under it. */
  disabledReason?: string;
}

/**
 * A labelled radio group (accessibility.md 1.5: role radiogroup, roving tabindex, arrows move and select). Each option is at least 44 px
 * high; the state is never colour alone (a ring holds a dot when selected); a disabled option says why.
 */
export function Choices<Value extends string>({
  label,
  value,
  onChange,
  choices,
  disabled = false,
  name,
}: {
  label: string;
  value: Value | null;
  onChange(value: Value): void;
  choices: readonly Choice<Value>[];
  disabled?: boolean;
  name?: string;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value ?? ""}
      onValueChange={(next) => onChange(next as Value)}
      disabled={disabled}
      orientation="vertical"
      {...(name ? { name } : {})}
      className="flex flex-col gap-1.5"
    >
      {choices.map((choice) => (
        <div key={choice.value} className="flex flex-col gap-1">
          <RadioGroup.Item
            value={choice.value}
            disabled={choice.disabledReason !== undefined}
            data-choice={choice.value}
            className="atlas-transition flex min-h-11 items-start gap-2.5 rounded-control border border-hairline-strong bg-canvas px-3 py-2.5 text-left text-[13px] text-ink-1 hover:border-field-edge disabled:opacity-60 data-[state=checked]:border-action-fill"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-[15px] flex-none items-center justify-center rounded-round border-[1.5px] border-field-edge"
            >
              <RadioGroup.Indicator className="size-[7px] rounded-round bg-action-fill" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{choice.label}</span>
              {choice.description ? (
                <span className="text-[12.5px] leading-[1.55] text-ink-2">
                  {choice.description}
                </span>
              ) : null}
            </span>
          </RadioGroup.Item>
          {choice.disabledReason ? (
            <span className="pl-3 text-[12px] text-ink-2">
              {choice.disabledReason}
            </span>
          ) : null}
        </div>
      ))}
    </RadioGroup.Root>
  );
}

/** Initials from the first grapheme of the first two words of a name; "?" when there is none. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const segmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  const first = (word: string) =>
    segmenter
      ? ([...segmenter.segment(word)][0]?.segment ?? "")
      : ([...word][0] ?? "");
  const out = words.map(first).join("").toUpperCase();
  return out === "" ? "?" : out;
}

/**
 * The large avatar's size: the exact values its two single-use utilities computed (a 3.5rem square, an 18px font). It is drawn once, on
 * the person's page, so a style of its own keeps those utilities out of the production CSS (the combined CSS budget, WEB-11a revision 11;
 * their class names are not written here, since the CSS build scans comments too).
 */
const LARGE = { width: "3.5rem", height: "3.5rem", fontSize: "18px" } as const;

export function Avatar({
  name,
  size = "small",
}: {
  name: string;
  size?: "small" | "large";
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex flex-none items-center justify-center rounded-round border border-hairline-strong bg-raised font-medium text-ink-1${size === "large" ? "" : " size-9 text-[13px]"}`}
      style={size === "large" ? LARGE : undefined}
    >
      {initialsOf(name)}
    </span>
  );
}

export function PendingBadge({ mark }: { mark: PendingMark | null }) {
  if (mark === null) return null;
  return (
    <span
      data-pending={mark}
      className="inline-flex items-center rounded-badge border border-hairline-strong px-1.5 py-0.5 text-[11.5px] text-ink-2"
    >
      {copy.PENDING[mark]}
    </span>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} data-field-error="" className="text-[12.5px] text-conflict-text">
      {message}
    </p>
  );
}

// ---- saving to the outbox ----------------------------------------------------------------------------------------------------------
export type SaveResult =
  | { ok: true; localId: string }
  /** Not saved. `message` is what to say, or null when the gate has taken over (nothing is shown). */
  | { ok: false; message: string | null };

type AnyOutcome = EnqueueOutcome | EditOutcome | SupersedeOutcome;

/** What a refusal says (§4.8): a failed local write is NEVER shown as saved. */
export function refusalMessage(reason: string): string | null {
  switch (reason) {
    case "closed":
    case "identity_changed":
      return null;
    case "fenced":
    case "closing":
    case "quota":
    case "storage":
    case "no_base":
      return copy.REFUSED[reason];
    default:
      return copy.REFUSED.storage;
  }
}

/**
 * Runs one save against the displayed account's outbox facade. A refusal is a typed answer (never a throw), and a defect in a request
 * (`OutboxRequestError`) is reported as not saved, never as saved.
 */
export function useOutboxSave(): (
  run: (outbox: Outbox) => Promise<AnyOutcome>,
) => Promise<SaveResult> {
  const env = useDataEnv();
  return useCallback(
    async (run) => {
      const outbox = env.outbox();
      if (outbox === null)
        return { ok: false, message: copy.REFUSED.not_ready };
      let outcome: AnyOutcome;
      try {
        outcome = await run(outbox);
      } catch {
        return { ok: false, message: copy.REFUSED.storage };
      }
      if (outcome.kind === "refused")
        return { ok: false, message: refusalMessage(outcome.reason) };
      return { ok: true, localId: outcome.localId };
    },
    [env],
  );
}
