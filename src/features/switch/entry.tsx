import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { useSessionView } from "../../session";
import { switchFlow } from "./state";
import { SWITCH_TITLE } from "./switch-labels";

/**
 * The ONLY part of the account switcher that the protected tree loads eagerly (WEB-08c, D-8c-05): the host that mounts the flow when
 * it is opened, and the "Switch account" control of the account card. WF-SWITCH-01/02 themselves are a lazily loaded chunk
 * (`SwitchFlow.tsx`), imported here and nowhere else (`tests/features/switch/lazy.test.ts`).
 */
const SwitchFlow = lazy(() => import("./SwitchFlow"));

/** The account that is displayed now, or null (the tree is mounted only while one is, so null is a transient). */
function useDisplayedAccount(): string | null {
  const view = useSessionView();
  return view.kind === "displaying" ? view.account_id : null;
}

/**
 * Mounted once in the protected tree. It shows the flow only for the account it was opened for, and drops a flow opened by a
 * DIFFERENT account the moment this one is displayed, so a picker or a form of one account can never appear over another's.
 */
export function SwitchHost() {
  const account = useDisplayedAccount();
  const stage = useSyncExternalStore(
    switchFlow.subscribe,
    switchFlow.get,
    switchFlow.get,
  );
  useEffect(() => {
    if (account !== null && stage.stage !== "closed" && stage.owner !== account)
      switchFlow.dropUnless(account);
  }, [account, stage]);
  if (account === null || stage.stage === "closed" || stage.owner !== account)
    return null;
  return (
    <Suspense fallback={null}>
      <SwitchFlow owner={account} />
    </Suspense>
  );
}

/** Opens the picker for the displayed account from a control (focus returns to it when the flow closes on this tree). */
export function openSwitcher(account: string, trigger: HTMLElement | null) {
  switchFlow.open(account, trigger);
}

/** The account card's "Switch account" (WF-SETTINGS-01, gap G-20): always available while the card is displayed. */
export function SwitchAction() {
  const account = useDisplayedAccount();
  if (account === null) return null;
  return (
    <Button
      aria-haspopup="dialog"
      data-switch-account=""
      onClick={(event) => openSwitcher(account, event.currentTarget)}
    >
      {SWITCH_TITLE}
    </Button>
  );
}
