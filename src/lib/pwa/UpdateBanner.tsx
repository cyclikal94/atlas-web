import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { neutralLiveRegion, useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import {
  DISCARD_FAILED_TEXT,
  RecoveryBanner,
  type RecoveryBannerState,
  SAVE_FAILED_TEXT,
  SAVE_REFUSED_TEXT,
} from "../form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../form-recovery/registry";
import { UpdatePrompt } from "../form-recovery/UpdatePrompt";
import {
  type AppUpdatesActions,
  appUpdates,
  type UpdateState,
  useAppUpdate,
} from "./store";

/**
 * The service-worker update banner (WEB-04 wireframe 6; WEB-14a D-P4/D-P5). Persistent, dismissible ("Not now" / the close button) until
 * the next return to the page, never auto-reloading, and never taking focus. The wording of the first two variants is the wireframe's;
 * the rest are PROPOSED (no accepted wireframe has them). With an open recoverable form, the "available" variant is WEB-07's Q4 state 1
 * (`UpdatePrompt`: "we'll save your unfinished form first"), and a failed save is its state 2 (`RecoveryBanner`).
 */
export const AVAILABLE_TEXT = "A new version of Atlas is available.";
export const ELSEWHERE_TEXT = "Atlas updated in another tab.";
export const SAVING_TEXT = "Saving your unfinished form before reloading…";
export const RELOADING_TEXT = "Reloading Atlas…";
export const SUPERSEDED_TEXT =
  "Atlas was updated in another tab and needs to reload here to keep working.";
/**
 * The failures as the NEUTRAL root says them (revision 12, R19). PROPOSED copy, not accepted. The page's forms and their saved copies
 * outlive the protected tree (a session gate hides or unmounts it, the coordinator keeps the failed act), so the choice is still owed there;
 * but nothing of the account is shown, so these name no form, no field and no account, and never say the form is still on screen.
 */
export const NEUTRAL_SAVE_FAILED_TEXT =
  "Atlas couldn't save unfinished changes before reloading. You can retry saving, or discard those changes and reload.";
export const NEUTRAL_SAVE_REFUSED_TEXT =
  "Atlas can't save unfinished changes while sign-out is in progress. You can discard those changes and reload.";
export const NEUTRAL_DISCARD_FAILED_TEXT =
  "Atlas couldn't clear an earlier saved copy. Try again, or reload knowing that copy may be restored afterwards.";

/** Where the banner is: the shell of the displayed account, or the neutral root (signed out, a neutral state), which shows no account. */
export type UpdateSurface = "protected" | "neutral";

/** One thing the person can do about the update: its button and the coordinator action it asks for. */
export interface UpdateChoice {
  label: string;
  act: keyof AppUpdatesActions;
  variant: "primary" | "secondary" | "quiet";
}

/** What the banner says about a state on a surface, and the person's choices (`failure`: nothing proceeds until they choose). */
export interface UpdateNotice {
  text: string;
  choices: readonly UpdateChoice[];
  failure: boolean;
}

const RELOAD: UpdateChoice = {
  label: "Reload",
  act: "accept",
  variant: "primary",
};
const RELOAD_HERE: UpdateChoice = { ...RELOAD, label: "Reload here" };
const NOT_NOW: UpdateChoice = {
  label: "Not now",
  act: "notNow",
  variant: "quiet",
};
const RETRY_SAVE: UpdateChoice = {
  label: "Retry save",
  act: "retrySave",
  variant: "secondary",
};
const DISCARD_AND_RELOAD: UpdateChoice = {
  label: "Discard and reload anyway",
  act: "discardAndReload",
  variant: "quiet",
};
const TRY_AGAIN: UpdateChoice = {
  label: "Try again",
  act: "discardAndReload",
  variant: "secondary",
};
const RELOAD_ANYWAY: UpdateChoice = {
  label: "Reload anyway",
  act: "reloadAnyway",
  variant: "quiet",
};

const plain = (
  text: string,
  choices: readonly UpdateChoice[] = [],
): UpdateNotice => ({ text, choices, failure: false });
const failed = (
  text: string,
  choices: readonly UpdateChoice[],
): UpdateNotice => ({ text, choices, failure: true });

/**
 * EVERY update state's notice and choices, on either surface (revision 12, R19, I1/I3). The choices are the same on both: a failure stays
 * the person's to resolve wherever they are, by the same coordinator action (a retry continues the failed act, it is never a new
 * acceptance). Only the wording differs: the shell's failures are WEB-07's Q4 state 2 (`RecoveryBanner`, the form is on screen), the
 * neutral root's name no form. A new kind does not compile until it is given one here (no catch-all hides it).
 */
export function noticeOf(
  state: UpdateState,
  surface: UpdateSurface,
): UpdateNotice | null {
  const neutral = surface === "neutral";
  switch (state.kind) {
    case "none":
      return null;
    case "available":
      return state.dismissed ? null : plain(AVAILABLE_TEXT, [RELOAD, NOT_NOW]);
    case "updated_elsewhere":
      return state.dismissed
        ? null
        : plain(ELSEWHERE_TEXT, [RELOAD_HERE, NOT_NOW]);
    case "saving":
      return plain(SAVING_TEXT);
    case "reloading":
      return plain(RELOADING_TEXT);
    case "data_superseded":
      return plain(SUPERSEDED_TEXT, [RELOAD_HERE]);
    case "save_failed":
      return state.refused
        ? failed(neutral ? NEUTRAL_SAVE_REFUSED_TEXT : SAVE_REFUSED_TEXT, [
            DISCARD_AND_RELOAD,
          ])
        : failed(neutral ? NEUTRAL_SAVE_FAILED_TEXT : SAVE_FAILED_TEXT, [
            RETRY_SAVE,
            DISCARD_AND_RELOAD,
          ]);
    case "discard_failed":
      return failed(
        neutral ? NEUTRAL_DISCARD_FAILED_TEXT : DISCARD_FAILED_TEXT,
        [TRY_AGAIN, RELOAD_ANYWAY],
      );
    default:
      return unknown(state);
  }
}

function unknown(state: never): never {
  throw new Error(`No update notice for ${JSON.stringify(state)}`);
}

/** The person's choice, asked of the coordinator only when they make it (never on render, mount or announcement). */
const run = (choice: UpdateChoice) => () =>
  appUpdates.actions()?.[choice.act]();

/** The shell's failures are the form's recovery banner (Q4 state 2), its callbacks the notice's own choices. */
function recoveryStateOf(
  state: UpdateState,
  notice: UpdateNotice,
): RecoveryBannerState | null {
  const [first, second] = notice.choices.map(run);
  if (state.kind === "discard_failed" && first && second)
    return { kind: "discard-failed", onRetry: first, onReloadAnyway: second };
  if (state.kind !== "save_failed" || !first) return null;
  if (state.refused) return { kind: "save-refused", onDiscardAndReload: first };
  return second
    ? { kind: "save-failed", onRetry: first, onDiscardAndReload: second }
    : null;
}

/** A notice and its choices, with no provider: the neutral root draws every state with it, the shell its plain ones. */
function Notice({
  state,
  notice,
}: {
  state: UpdateState;
  notice: UpdateNotice;
}) {
  if (notice.failure)
    return (
      <div
        data-app-update={state.kind}
        className="flex flex-col gap-3 rounded-row border border-conflict-edge bg-conflict-tint p-3.5"
      >
        <p className="text-[13.5px] leading-[1.6] text-conflict-text">
          {notice.text}
        </p>
        <div className="flex flex-wrap gap-2">
          {notice.choices.map((choice) => (
            <Button
              key={choice.label}
              variant={choice.variant}
              onClick={run(choice)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </div>
    );
  return (
    <div
      data-app-update={state.kind}
      className="flex flex-wrap items-center gap-3 rounded-row border border-action-tint-edge bg-action-tint p-3.5"
    >
      <p className="flex-1 text-[13.5px] leading-[1.6] text-ink-1">
        {notice.text}
      </p>
      {notice.choices.map((choice) =>
        choice.act === "notNow" ? (
          <Button
            key={choice.label}
            variant={choice.variant}
            aria-label={choice.label}
            onClick={run(choice)}
          >
            <X aria-hidden="true" size={16} />
          </Button>
        ) : (
          <Button
            key={choice.label}
            variant={choice.variant}
            onClick={run(choice)}
          >
            {choice.label}
          </Button>
        ),
      )}
    </div>
  );
}

const subscribeForms = (listener: () => void) =>
  pageFormRegistry.subscribe(listener);
const formsOpen = () => pageFormRegistry.all().length > 0;

/** The banner in the protected tree (the shell), where forms live and the announcer is mounted. */
export function AppUpdateBanner() {
  const state = useAppUpdate();
  const announcer = useAnnouncer();
  const withForms = useSyncExternalStore(subscribeForms, formsOpen, formsOpen);
  const notice = noticeOf(state, "protected");
  // The Q4 variants announce themselves (UpdatePrompt, RecoveryBanner).
  const prompt = state.kind === "available" && !state.dismissed && withForms;
  const recovery = notice?.failure ? recoveryStateOf(state, notice) : null;
  const text = prompt || recovery ? null : (notice?.text ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per message, not per announcer identity
  useEffect(() => {
    if (text) announcer.announce(text);
  }, [text]);
  if (recovery)
    return (
      <section aria-label="Update" className="mb-5">
        <RecoveryBanner state={recovery} />
      </section>
    );
  if (prompt)
    return (
      <section aria-label="Update" className="mb-5">
        <UpdatePrompt
          onSaveAndReload={() => appUpdates.actions()?.accept()}
          onNotNow={() => appUpdates.actions()?.notNow()}
        />
      </section>
    );
  if (!notice) return null;
  return (
    <section aria-label="Update" className="mb-5">
      <Notice state={state} notice={notice} />
    </section>
  );
}

/**
 * The banner in the neutral root (signed out, a neutral state). It shows no account and no form, but it is where the person is while a
 * session gate hides the shell, and the page's forms, their saved copies and the coordinator's failed act outlive the shell (revision 12,
 * R19): so it draws EVERY state, a failure with its choices, in the neutral wording. Each message is announced once through the neutral
 * root's own live region (revision 1, R8: `NeutralLiveRegion`, kept mounted by the neutral root before this banner loads), never by moving
 * focus; when the message goes (dismissed, or no update left) the region is emptied, so no earlier message (such as "Saving…" once the save
 * has failed) stays in it. The session gate's clearing stays authoritative: a message it cleared is not written back.
 */
export function NeutralUpdateBanner() {
  const state = useAppUpdate();
  const notice = noticeOf(state, "neutral");
  const text = notice?.text ?? null;
  useEffect(() => {
    if (!text) return;
    neutralLiveRegion.announce(text);
    return () => neutralLiveRegion.clear();
  }, [text]);
  if (!notice) return null;
  return (
    <section
      aria-label="Update"
      className="fixed inset-x-4 top-4 z-30 tablet:inset-x-auto tablet:right-4 tablet:w-[420px]"
    >
      <Notice state={state} notice={notice} />
    </section>
  );
}

export default NeutralUpdateBanner;
