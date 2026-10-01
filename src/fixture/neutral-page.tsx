import { createRoot } from "react-dom/client";
import { createGateDialog } from "../components/ui/gate-dialog";
import { NeutralState } from "../components/ui/neutral-state";
import { ThemeProvider } from "../design/ThemeProvider";
import type { ConsentTicket, NeutralStateId } from "../session";

/**
 * FIXTURE ONLY. `/__neutral?state=<id>` renders one neutral state (or `state=gate`, the level-0 resume gate) so a real engine
 * can measure it at four widths in both themes: layout, contrast, targets, focus. `count` gives the consent prompt its number.
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
  createRoot(root).render(
    <ThemeProvider>
      <NeutralState
        state={state as NeutralStateId}
        consent={{
          count: Number(params.get("count") ?? 4),
          ticket: "fixture-prompt" as ConsentTicket,
        }}
        unavailable={
          params.get("unavailable") === "1"
            ? "Sign-in isn't available in this build yet."
            : null
        }
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
