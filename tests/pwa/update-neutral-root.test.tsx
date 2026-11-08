import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef, useSyncExternalStore } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { SessionRoot } from "../../src/app/SessionRoot";
import {
  AnnouncerProvider,
  neutralLiveRegion,
} from "../../src/components/ui/announcer";
import { handoffContext } from "../../src/lib/form-recovery/handoff";
import type {
  DiscardResult,
  FormRecoveryPort,
  RecoverySnapshot,
  SaveResult,
} from "../../src/lib/form-recovery/port";
import { useRecoverableForm } from "../../src/lib/form-recovery/use-recoverable-form";
import {
  type AppUpdateCoordinator,
  startAppUpdates,
} from "../../src/lib/pwa/coordinator";
import { onNavigation } from "../../src/lib/pwa/navigation";
import { appUpdates, type UpdateState } from "../../src/lib/pwa/store";
import {
  AppUpdateBanner,
  NEUTRAL_DISCARD_FAILED_TEXT,
  NEUTRAL_SAVE_FAILED_TEXT,
  NEUTRAL_SAVE_REFUSED_TEXT,
  SAVING_TEXT,
} from "../../src/lib/pwa/UpdateBanner";
import {
  SessionProvider,
  type SessionView,
  type Store,
} from "../../src/session";
import {
  attemptsDouble,
  sessionDouble,
  store,
} from "../helpers/session-double";
import { type Page, TITLE, World } from "../support/recovery-pages";
import { Clock, flush } from "./coordinator-world";

/**
 * WEB-14a revision 12, R19 (review of 14 October 2026; design assessment Q2/Q3, schedules S2-S7 and S17): a failed update save or discard
 * is still the person's to resolve when a session gate has replaced the shell with the neutral root. The REAL form (hook, session, page
 * registry handle, recovery identity, hand-offs), the REAL app-update coordinator publishing to the app's update store, the ACTUAL
 * `SessionRoot` (its lazy neutral banner and live region) and the shell's `AppUpdateBanner` in an `AnnouncerProvider`, as the app composes
 * them. The session's view is a controlled store: `displaying` mounts the shell and its form, a neutral state (1c.offline) unmounts it, as
 * the protected-surface adapter does. The store is the memory adapter behind a port whose saves can fail, be refused or be held. The
 * update is offered by the data-superseded signal (no worker registration), so an accepted act reloads (a spy) once its forms are settled.
 *
 * Each REQUIREMENT is paired with a CONTROL on the protected surface (the same schedule, the shell kept). Limits: jsdom, memory store and
 * a manual clock; the native engines with W9/IndexedDB and Web Locks are the revision-12 native probes.
 */
const CONTEXT = "neutral-root-form";
const OTHER = "neutral-root-second";
const PRIVATE = "PRIVATE UNSAVED INPUT";
const LATER = "PRIVATE LATER INPUT";
const DISPLAYING: SessionView = {
  kind: "displaying",
  account_id: "acct",
  epoch: 1,
};
const GATED: SessionView = { kind: "neutral", state: "1c.offline" };

/** A port over the world's store whose saves fail, are refused, or are held until the test settles them, per form. */
class ControlledPort implements FormRecoveryPort {
  saveOutcome: (formContext: string) => SaveResult | "store" | "hold" = () =>
    "store";
  readonly saves: string[] = [];
  private held: Array<(result: SaveResult) => void> = [];
  constructor(private readonly inner: FormRecoveryPort) {}
  save(snapshot: RecoverySnapshot): Promise<SaveResult> {
    this.saves.push(snapshot.formContext);
    const outcome = this.saveOutcome(snapshot.formContext);
    if (outcome === "store") return this.inner.save(snapshot);
    if (outcome === "hold")
      return new Promise((resolve) => {
        this.held.push((result) =>
          result === "saved"
            ? resolve(this.inner.save(snapshot))
            : resolve(result),
        );
      });
    return Promise.resolve(outcome);
  }
  /** Settles every held save with `result` ("saved" writes it to the store). */
  release(result: SaveResult): void {
    for (const settle of this.held.splice(0)) settle(result);
  }
  get holding(): number {
    return this.held.length;
  }
  load(formContext: string, tabInstanceId: string) {
    return this.inner.load(formContext, tabInstanceId);
  }
  discard(
    formContext: string,
    tabInstanceId: string,
    capture?: string,
  ): Promise<DiscardResult> {
    return this.inner.discard(formContext, tabInstanceId, capture);
  }
  list(formContext: string) {
    return this.inner.list(formContext);
  }
}

class ViewStore implements Store<SessionView> {
  private listeners = new Set<() => void>();
  constructor(private view: SessionView) {}
  get = (): SessionView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(view: SessionView): void {
    this.view = view;
    for (const listener of [...this.listeners]) listener();
  }
}

interface App {
  world: World;
  page: Page;
  port: ControlledPort;
  view: ViewStore;
  clock: Clock;
  reloads: () => number;
  coordinator: AppUpdateCoordinator;
  supersede: () => void;
}

let running: App | null = null;
afterEach(async () => {
  running?.coordinator.dispose();
  running = null;
  cleanup();
  act(() => appUpdates.set({ kind: "none" }));
  neutralLiveRegion.clear();
});

function Form({ page, context }: { page: Page; context: string }) {
  const ref = useRef<HTMLFormElement>(null);
  page.handles.set(
    context,
    useRecoverableForm({
      formContext: context,
      allow: TITLE,
      formRef: ref,
      port: page.port,
      registry: page.registry,
      tab: page.tab,
      handoffs: page.handoffs,
    }),
  );
  return (
    <form ref={ref} aria-label={context}>
      <input name="title" aria-label={`Title ${context}`} defaultValue="" />
    </form>
  );
}

function Composition({ app, forms }: { app: App; forms: string[] }) {
  const view = useSyncExternalStore(app.view.subscribe, app.view.get);
  const session = sessionDouble(
    {},
    {
      view: app.view,
      compat: store({ status: "supported", version: "0.28.0" }),
      attempts: attemptsDouble(),
    },
  );
  return (
    <SessionProvider session={session}>
      {view.kind === "displaying" ? (
        <div data-testid="shell">
          <AnnouncerProvider>
            <AppUpdateBanner />
            {forms.map((context) => (
              <Form key={context} page={app.page} context={context} />
            ))}
          </AnnouncerProvider>
        </div>
      ) : null}
      <SessionRoot pathname="/" />
    </SessionProvider>
  );
}

async function start(forms = [CONTEXT]): Promise<App> {
  const world = new World();
  const page = world.page("A", undefined, forms);
  const port = new ControlledPort(page.spy);
  page.port = port;
  const view = new ViewStore(DISPLAYING);
  const clock = new Clock();
  let reloads = 0;
  let supersede = () => {};
  const coordinator = startAppUpdates({
    container: null,
    entry: null,
    page: { on: () => () => {}, isVisible: () => true },
    clock,
    ids: { uuid: () => crypto.randomUUID() },
    channel: () => null,
    messageChannel: () => null,
    forms: page.registry,
    compat: { get: () => ({ status: "supported" }), subscribe: () => () => {} },
    onDataSuperseded: (listener) => {
      supersede = listener;
      return () => {};
    },
    onNavigation,
    reload: () => {
      reloads += 1;
    },
    publish: (state, actions) => appUpdates.set(state, actions),
  });
  const app: App = {
    world,
    page,
    port,
    view,
    clock,
    reloads: () => reloads,
    coordinator,
    supersede: () => act(() => supersede()),
  };
  running = app;
  render(<Composition app={app} forms={forms} />);
  await waitFor(() =>
    expect(forms.every((context) => page.handles.get(context)?.ready)).toBe(
      true,
    ),
  );
  return app;
}

const type = (value: string, context = CONTEXT) =>
  act(() => {
    fireEvent.input(screen.getByLabelText(`Title ${context}`), {
      target: { value },
    });
  });
const state = (): UpdateState => appUpdates.get();
/** Lets the act's saves, hand-offs and clean-ups settle (the coordinator's own waits run on the manual clock). */
const settle = async (app: App) => {
  await act(async () => {
    await flush();
    await app.clock.advance(5_000);
    await flush();
  });
};
const gate = async (app: App) => {
  act(() => app.view.set(GATED));
  await screen.findByRole("heading", {
    name: "Reconnect to finish signing in",
  });
  expect(screen.queryByTestId("shell")).toBeNull();
};
const ungate = async (app: App) => {
  act(() => app.view.set(DISPLAYING));
  await screen.findByTestId("shell");
};
const region = () =>
  document.querySelector("[data-neutral-live-region]") as HTMLElement;
/**
 * The neutral notice's own text, not the live region's copy of it: the region is written on the next animation frame (and asserted
 * separately after `frame()`), so an unscoped lookup finds the text twice whenever a frame has passed (WEB-14a revision 14: one failure
 * of the full unit suite under load; forced with one frame, deterministic).
 */
const NOT_REGION = { ignore: "script, style, [data-neutral-live-region]" };
const frame = () =>
  act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(0))));
/** The update banner on whichever surface shows it (the neutral one loads lazily): its absence fails by assertion, not by a lookup error. */
const banner = async (): Promise<HTMLElement> => {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = screen.queryByRole("region", { name: "Update" });
    expect(found, "an update banner is shown").not.toBeNull();
  });
  return found as unknown as HTMLElement;
};
const updateButton = async (name: string) => {
  const button = within(await banner()).queryByRole("button", { name });
  expect(button, `the update banner offers '${name}'`).not.toBeNull();
  return button as HTMLElement;
};
const choices = async () =>
  within(await banner())
    .queryAllByRole("button")
    .map((button) => button.textContent || button.getAttribute("aria-label"));
const click = async (app: App, name: string) => {
  const button = await updateButton(name);
  await act(async () => {
    button.click();
  });
  await settle(app);
};
const rows = async (world: World, context = CONTEXT) => [
  ...(await world.store.list(context)),
  ...(await world.store.list(handoffContext(context))),
];

describe("R19 (S2): a save that fails after the shell was unmounted by a session gate", () => {
  for (const neutral of [false, true])
    test(`${neutral ? "REQUIREMENT" : "CONTROL"}: 'Reload here' on the ${neutral ? "neutral root" : "shell"} fails; Retry save and Discard and reload anyway are offered there, nothing reloads; restored, Retry save reloads once`, async () => {
      const app = await start();
      type(PRIVATE);
      expect(app.page.registry.dirty()).toHaveLength(1);
      if (neutral) await gate(app);
      app.port.saveOutcome = () => "failed";
      app.supersede();
      await click(app, "Reload here");
      expect(state()).toEqual({ kind: "save_failed", refused: false });
      expect(app.reloads()).toBe(0);
      expect(app.page.registry.dirty()).toHaveLength(1);
      expect(await choices()).toEqual([
        "Retry save",
        "Discard and reload anyway",
      ]);
      if (neutral) {
        expect(document.body.textContent).not.toContain("PRIVATE");
        expect(document.body.textContent).not.toContain(CONTEXT);
        expect(
          screen.getByText(NEUTRAL_SAVE_FAILED_TEXT, NOT_REGION),
        ).toBeInTheDocument();
        await frame();
        expect(region()).toHaveTextContent(NEUTRAL_SAVE_FAILED_TEXT);
      }
      app.port.saveOutcome = () => "store";
      await click(app, "Retry save");
      expect(app.reloads()).toBe(1);
      expect(
        (await rows(app.world)).map((copy) => copy.values.title),
      ).toContain(PRIVATE);
    });
});

describe("R19 (S3): the gate comes while the save is in flight, and the save then fails", () => {
  for (const outcome of ["failed", "saved"] as const)
    test(`${outcome === "failed" ? "REQUIREMENT" : "CONTROL"}: 'Saving…' on the neutral root, then ${outcome === "failed" ? "the failure and its choices replace it (shown and announced), nothing reloads" : "the save lands and the tab reloads once"}`, async () => {
      const app = await start();
      type(PRIVATE);
      app.port.saveOutcome = () => "hold";
      app.supersede();
      await click(app, "Reload here");
      expect(state()).toEqual({ kind: "saving" });
      expect(app.port.holding).toBe(1);
      await gate(app);
      await frame();
      expect(region()).toHaveTextContent(SAVING_TEXT);
      app.port.saveOutcome = () => "store";
      await act(async () => app.port.release(outcome));
      await settle(app);
      if (outcome === "saved") {
        expect(app.reloads()).toBe(1);
        return;
      }
      expect(state()).toEqual({ kind: "save_failed", refused: false });
      expect(app.reloads()).toBe(0);
      expect(await choices()).toEqual([
        "Retry save",
        "Discard and reload anyway",
      ]);
      await frame();
      expect(region()).toHaveTextContent(NEUTRAL_SAVE_FAILED_TEXT);
      expect(region()).not.toHaveTextContent(SAVING_TEXT);
    });
});

describe("R19 (S4): a failure on the shell survives the gate, and the gate's end", () => {
  test("REQUIREMENT: shell → neutral root → shell keeps the same choices; Retry save (twice clicked) continues the act and reloads once", async () => {
    const app = await start();
    type(PRIVATE);
    app.port.saveOutcome = () => "failed";
    app.supersede();
    await click(app, "Reload here");
    expect(await choices()).toEqual([
      "Retry save",
      "Discard and reload anyway",
    ]);
    await gate(app);
    expect(await choices()).toEqual([
      "Retry save",
      "Discard and reload anyway",
    ]);
    await ungate(app);
    expect(await choices()).toEqual([
      "Retry save",
      "Discard and reload anyway",
    ]);
    // The same session was kept (nothing re-typed): it is still dirty and still owed.
    expect(app.page.registry.dirty()).toHaveLength(1);
    // Each save of the form itself (its hand-off is another context): one retry is one save.
    const ownSaves = () =>
      app.port.saves.filter((context) => context === CONTEXT).length;
    const saves = ownSaves();
    app.port.saveOutcome = () => "store";
    const retry = await updateButton("Retry save");
    await act(async () => {
      retry.click();
      retry.click();
    });
    await settle(app);
    expect(app.reloads()).toBe(1);
    expect(ownSaves() - saves).toBe(1);
  });
});

describe("R19 (S5): a save refused while the account is being signed out", () => {
  for (const neutral of [false, true])
    test(`${neutral ? "REQUIREMENT" : "CONTROL"}: on the ${neutral ? "neutral root" : "shell"} only 'Discard and reload anyway' is offered (no retry); it discards and reloads once`, async () => {
      const app = await start();
      type(PRIVATE);
      if (neutral) await gate(app);
      app.port.saveOutcome = () => "refused";
      app.supersede();
      await click(app, "Reload here");
      expect(state()).toEqual({ kind: "save_failed", refused: true });
      expect(app.reloads()).toBe(0);
      expect(await choices()).toEqual(["Discard and reload anyway"]);
      if (neutral)
        expect(
          screen.getByText(NEUTRAL_SAVE_REFUSED_TEXT, NOT_REGION),
        ).toBeInTheDocument();
      await click(app, "Discard and reload anyway");
      expect(app.reloads()).toBe(1);
    });
});

describe("R19 (S6/S7): a discard that fails, with a copy saved earlier", () => {
  for (const neutral of [false, true])
    for (const then of ["Try again", "Reload anyway"] as const)
      test(`${neutral ? "REQUIREMENT" : "CONTROL"}: on the ${neutral ? "neutral root" : "shell"} 'Try again' and 'Reload anyway' are offered, nothing reloads; '${then}' ${then === "Try again" ? "(the store restored) removes the copy, then reloads once" : "reloads once and the earlier copy remains"}`, async () => {
        const app = await start();
        type(PRIVATE);
        expect(await app.page.flush()).toEqual(["saved"]);
        type(LATER);
        app.port.saveOutcome = () => "failed";
        app.supersede();
        await click(app, "Reload here");
        expect(state()).toEqual({ kind: "save_failed", refused: false });
        app.world.store.failDiscardOf = () => true;
        if (neutral) await gate(app);
        await click(app, "Discard and reload anyway");
        expect(state()).toEqual({ kind: "discard_failed" });
        expect(app.reloads()).toBe(0);
        expect(await choices()).toEqual(["Try again", "Reload anyway"]);
        if (neutral) {
          expect(document.body.textContent).not.toContain("PRIVATE");
          expect(
            screen.getByText(NEUTRAL_DISCARD_FAILED_TEXT, NOT_REGION),
          ).toBeInTheDocument();
          await frame();
          expect(region()).toHaveTextContent(NEUTRAL_DISCARD_FAILED_TEXT);
        }
        // Rendering, re-rendering and announcing choose nothing.
        await frame();
        expect(app.reloads()).toBe(0);
        if (then === "Try again") app.world.store.failDiscardOf = () => false;
        await click(app, then);
        expect(app.reloads()).toBe(1);
        expect(
          (await rows(app.world)).map((copy) => copy.values.title),
        ).toEqual(then === "Try again" ? [] : [PRIVATE]);
      });
});

describe("R19 (S17): two forms, one saved and one failing, resolved from the neutral root", () => {
  for (const neutral of [false, true])
    test(`${neutral ? "REQUIREMENT" : "CONTROL"}: 'Discard and reload anyway' on the ${neutral ? "neutral root" : "shell"} discards both forms' copies of the act and reloads once`, async () => {
      const app = await start([CONTEXT, OTHER]);
      type(PRIVATE, CONTEXT);
      type(LATER, OTHER);
      app.port.saveOutcome = (context) =>
        context === OTHER ? "failed" : "store";
      app.supersede();
      await click(app, "Reload here");
      expect(state()).toEqual({ kind: "save_failed", refused: false });
      expect(
        (await rows(app.world, CONTEXT)).map((copy) => copy.values.title),
      ).toContain(PRIVATE);
      if (neutral) await gate(app);
      await click(app, "Discard and reload anyway");
      expect(app.reloads()).toBe(1);
      expect(await rows(app.world, CONTEXT)).toEqual([]);
      expect(await rows(app.world, OTHER)).toEqual([]);
    });
});
