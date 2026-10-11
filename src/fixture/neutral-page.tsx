import { createRoot } from "react-dom/client";
import { createGateDialog } from "../components/ui/gate-dialog";
import { NeutralState } from "../components/ui/neutral-state";
import { ThemeProvider } from "../design/ThemeProvider";
import { SignInSurface } from "../features/authentication/SignInSurface";
import {
  type ConsentTicket,
  type NeutralStateId,
  SessionProvider,
} from "../session";
import { fixtureSession } from "./session-double";

/**
 * FIXTURE ONLY. `/__neutral?state=<id>` renders one neutral state (or `state=gate`, the level-0 resume gate) so a real engine
 * can measure it at four widths in both themes: layout, contrast, targets, focus. `count` gives the consent prompt its number.
 * `form=1` renders the sign-in form a "Sign in again" / "Reconnect" button leads to (WEB-08b), in its reauthenticate mode.
 */
export function mountNeutralPage(params: URLSearchParams): void {
  const root = document.getElementById("neutral-root");
  if (!root) throw new Error("Missing neutral root");
  const state = params.get("state") ?? "1b";
  if (state === "gate") {
    root.replaceChildren();
    const gate = createGateDialog();
    gate.open();
    gate.focusHeading();
    return;
  }
  const noop = () => undefined;
  if (params.get("form") === "1") {
    createRoot(root).render(
      <ThemeProvider>
        <SessionProvider session={fixtureSession(params)}>
          <SignInSurface mode="reauthenticate" onBack={noop} navigate={noop} />
        </SessionProvider>
      </ThemeProvider>,
    );
    return;
  }
  createRoot(root).render(
    <ThemeProvider>
      <NeutralState
        state={state as NeutralStateId}
        consent={{
          count: Number(params.get("count") ?? 4),
          ticket: "fixture-prompt" as ConsentTicket,
        }}
        actions={{
          signIn: noop,
          retry: noop,
          reload: noop,
          reviewDevice: noop,
          consent: noop,
        }}
      />
    </ThemeProvider>,
  );
}
