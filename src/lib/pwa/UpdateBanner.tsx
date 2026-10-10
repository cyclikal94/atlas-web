import { X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { neutralLiveRegion, useAnnouncer } from "../../components/ui/announcer";
import { Button } from "../../components/ui/button";
import { RecoveryBanner } from "../form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../form-recovery/registry";
import { UpdatePrompt } from "../form-recovery/UpdatePrompt";
import { appUpdates, type UpdateState, useAppUpdate } from "./store";

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

const textOf = (state: UpdateState): string | null => {
  switch (state.kind) {
    case "available":
      return state.dismissed ? null : AVAILABLE_TEXT;
    case "updated_elsewhere":
      return state.dismissed ? null : ELSEWHERE_TEXT;
    case "saving":
      return SAVING_TEXT;
    case "reloading":
      return RELOADING_TEXT;
    case "data_superseded":
      return SUPERSEDED_TEXT;
    default:
      return null;
  }
};

const actions = () => appUpdates.actions();

function Plain({ state, text }: { state: UpdateState; text: string }) {
  const dismissible =
    state.kind === "available" || state.kind === "updated_elsewhere";
  const action =
    state.kind === "available"
      ? "Reload"
      : state.kind === "updated_elsewhere" || state.kind === "data_superseded"
        ? "Reload here"
        : null;
  return (
    <div
      data-app-update={state.kind}
      className="flex flex-wrap items-center gap-3 rounded-row border border-action-tint-edge bg-action-tint p-3.5"
    >
      <p className="flex-1 text-[13.5px] leading-[1.6] text-ink-1">{text}</p>
      {action ? (
        <Button variant="primary" onClick={() => actions()?.accept()}>
          {action}
        </Button>
      ) : null}
      {dismissible ? (
        <Button
          variant="quiet"
          aria-label="Not now"
          onClick={() => actions()?.notNow()}
        >
          <X aria-hidden="true" size={16} />
        </Button>
      ) : null}
    </div>
  );
}

/** Announces each new message once, through `announce`; never moves focus. */
function useAnnounceOnce(
  text: string | null,
  announce: (message: string) => void,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce once per message, not per announcer identity
  useEffect(() => {
    if (text) announce(text);
  }, [text]);
}

const subscribeForms = (listener: () => void) =>
  pageFormRegistry.subscribe(listener);
const formsOpen = () => pageFormRegistry.all().length > 0;

/** The banner in the protected tree (the shell), where forms live and the announcer is mounted. */
export function AppUpdateBanner() {
  const state = useAppUpdate();
  const announcer = useAnnouncer();
  const withForms = useSyncExternalStore(subscribeForms, formsOpen, formsOpen);
  const text = textOf(state);
  // The Q4 variants announce themselves (UpdatePrompt, RecoveryBanner).
  const prompt = state.kind === "available" && !state.dismissed && withForms;
  useAnnounceOnce(prompt ? null : text, (message) =>
    announcer.announce(message),
  );
  if (state.kind === "discard_failed")
    return (
      <section aria-label="Update" className="mb-5">
        <RecoveryBanner
          state={{
            kind: "discard-failed",
            onRetry: () => actions()?.discardAndReload(),
            onReloadAnyway: () => actions()?.reloadAnyway(),
          }}
        />
      </section>
    );
  if (state.kind === "save_failed")
    return (
      <section aria-label="Update" className="mb-5">
        <RecoveryBanner
          state={
            state.refused
              ? {
                  kind: "save-refused",
                  onDiscardAndReload: () => actions()?.discardAndReload(),
                }
              : {
                  kind: "save-failed",
                  onRetry: () => actions()?.retrySave(),
                  onDiscardAndReload: () => actions()?.discardAndReload(),
                }
          }
        />
      </section>
    );
  if (prompt)
    return (
      <section aria-label="Update" className="mb-5">
        <UpdatePrompt
          onSaveAndReload={() => actions()?.accept()}
          onNotNow={() => actions()?.notNow()}
        />
      </section>
    );
  if (!text) return null;
  return (
    <section aria-label="Update" className="mb-5">
      <Plain state={state} text={text} />
    </section>
  );
}

/**
 * The banner in the neutral root (signed out, a neutral state): no account and no forms are shown there, so only the plain variants. Each
 * message is announced once through the neutral root's own live region (revision 1, R8: `NeutralLiveRegion`, kept mounted by the neutral
 * root before this banner loads), never by moving focus.
 */
export function NeutralUpdateBanner() {
  const state = useAppUpdate();
  const text = textOf(state);
  useAnnounceOnce(text, (message) => neutralLiveRegion.announce(message));
  if (!text) return null;
  return (
    <section
      aria-label="Update"
      className="fixed inset-x-4 top-4 z-30 tablet:inset-x-auto tablet:right-4 tablet:w-[420px]"
    >
      <Plain state={state} text={text} />
    </section>
  );
}

export default NeutralUpdateBanner;
