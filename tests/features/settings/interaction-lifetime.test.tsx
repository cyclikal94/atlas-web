import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ReactElement, StrictMode, useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import {
  beginInteraction,
  DismissalScopeProvider,
  type Interaction,
  interactionLifetime,
  useDismissalScope,
  useInteractions,
} from "../../../src/features/settings/sessions-devices/ownership";
import {
  type Identity,
  type Session,
  SessionProvider,
  type Store,
} from "../../../src/session";
import { sessionDouble } from "../../helpers/session-double";

/**
 * WEB-08d revision 17 (after review r16): a press in the moment between a component's first render and its effects lost its outcome,
 * because React StrictMode's simulated unmount (development only) ran the effect's cleanup, which ended every open interaction.
 * `interactionLifetime` keeps a genuine unmount ending them at once and makes the simulated one end nothing. Found as an intermittent
 * failure of completion-ownership.test.tsx's A4 controls under load; this file reproduces both schedules deterministically.
 */
const A: Identity = { account_id: "acct", epoch: 1, session_id: "sess-1" };

function identityStore(initial: Identity) {
  let value: Identity | null = initial;
  const listeners = new Set<() => void>();
  const store: Store<Identity | null> & { set(next: Identity | null): void } = {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

/** The end of the current turn: every microtask queued so far (and those they queue) has run. */
const endOfTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const live = (i: Interaction) => ({
  current: i.current(),
  withdrawn: i.withdraw.aborted,
});

afterEach(() => {
  cleanup();
});

describe("interactionLifetime: a genuine unmount ends every open interaction at once; StrictMode's simulated one ends nothing", () => {
  const session = () => sessionDouble({}, { identity: identityStore(A) });

  test("control: a cleanup in a later turn than its setup (a genuine unmount) ends them at once", async () => {
    const life = interactionLifetime(true);
    const disconnect = life.connect();
    const x = life.adopt(beginInteraction(session()));
    await endOfTurn();
    expect(live(x)).toEqual({ current: true, withdrawn: false });
    disconnect();
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("StrictMode's simulated unmount (cleanup and reconnect in the setup's turn) ends nothing, even what was begun before the setup", async () => {
    const life = interactionLifetime(true);
    const x = life.adopt(beginInteraction(session()));
    const first = life.connect();
    first();
    const second = life.connect();
    expect(live(x)).toEqual({ current: true, withdrawn: false });
    await endOfTurn();
    expect(live(x)).toEqual({ current: true, withdrawn: false });
    // The genuine unmount that follows, in a later turn, still ends it at once.
    second();
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("after StrictMode's pass, a genuine unmount in the same turn ends them at once (only the first cleanup can be simulated)", () => {
    const life = interactionLifetime(true);
    const x = life.adopt(beginInteraction(session()));
    life.connect()();
    const second = life.connect();
    second();
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("a genuine unmount in the turn of the first setup (no StrictMode, development): nothing is current at once, and every one ends at the end of the turn", async () => {
    const life = interactionLifetime(true);
    const x = life.adopt(beginInteraction(session()));
    const disconnect = life.connect();
    disconnect();
    expect(live(x).current).toBe(false);
    await endOfTurn();
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("production (no simulated unmount): a cleanup ends them at once even in the turn of its setup", () => {
    const life = interactionLifetime(false);
    const x = life.adopt(beginInteraction(session()));
    const disconnect = life.connect();
    disconnect();
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("a dismissal or an identity change ends or suppresses at once, attached or detached", async () => {
    const identity = identityStore(A);
    const s = sessionDouble({}, { identity });
    const life = interactionLifetime(true);
    const first = life.connect();
    const dismissed = life.adopt(beginInteraction(s));
    const moved = life.adopt(beginInteraction(s));
    const same = life.adopt(beginInteraction(s));
    // Detached (a simulated unmount in progress): an end is still immediate.
    first();
    dismissed.end();
    expect(live(dismissed)).toEqual({ current: false, withdrawn: true });
    life.connect();
    await endOfTurn();
    identity.set({ ...A });
    expect(live(same).current).toBe(true);
    identity.set({ ...A, epoch: 2 });
    expect(live(moved).current).toBe(false);
    expect(live(same).current).toBe(false);
  });
});

/** A component with one action; `pressEarly` presses it in a layout effect, after the first render and BEFORE its `useEffect` runs. */
function Probe({
  onBegin,
  pressEarly = false,
}: {
  onBegin(interaction: Interaction): void;
  pressEarly?: boolean;
}) {
  const interactions = useInteractions();
  const button = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  useLayoutEffect(() => {
    if (!pressEarly || pressed.current) return;
    pressed.current = true;
    button.current?.click();
  }, [pressEarly]);
  return (
    <button
      ref={button}
      type="button"
      onClick={() => onBegin(interactions.begin())}
    >
      Act
    </button>
  );
}

/**
 * Mounts the probe as the app mounts a form's panel: in a LATER render, inside a tree already mounted (React 19 simulates the unmount
 * only for a component placed inside an existing StrictMode subtree, as `Unconfirmed` is inside `ProtectedProviders`).
 */
function mount(
  session: Session,
  probe: (onBegin: (i: Interaction) => void) => ReactElement,
  strict: boolean,
) {
  const begun: Interaction[] = [];
  const tree = probe((i) => begun.push(i));
  const page = (shown: boolean) => (
    <SessionProvider session={session}>
      {strict ? (
        <StrictMode>{shown ? tree : null}</StrictMode>
      ) : shown ? (
        tree
      ) : null}
    </SessionProvider>
  );
  const view = render(page(false));
  view.rerender(page(true));
  return { begun, view };
}

describe("useInteractions under React StrictMode (kept enabled)", () => {
  test.each([
    ["StrictMode", true],
    ["control: no StrictMode", false],
  ])(
    "%s: a press before the component's effects ran keeps its interaction",
    (_name, strict) => {
      const { begun } = mount(
        sessionDouble({}, { identity: identityStore(A) }),
        (onBegin) => <Probe onBegin={onBegin} pressEarly />,
        strict,
      );
      expect(begun).toHaveLength(1);
      expect(live(begun[0] as Interaction)).toEqual({
        current: true,
        withdrawn: false,
      });
    },
  );

  test.each([
    ["pressed before its effects ran", true],
    ["pressed after", false],
  ])("a genuine unmount ends the interaction at once (%s)", (_name, early) => {
    const { begun, view } = mount(
      sessionDouble({}, { identity: identityStore(A) }),
      (onBegin) => <Probe onBegin={onBegin} pressEarly={early} />,
      true,
    );
    if (!early) fireEvent.click(screen.getByRole("button", { name: "Act" }));
    const x = begun[0] as Interaction;
    expect(live(x)).toEqual({ current: true, withdrawn: false });
    view.unmount();
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("a dismissal ends the interaction at once", () => {
    let scope: ReturnType<typeof useDismissalScope> | null = null;
    function Dialog({ onBegin }: { onBegin(i: Interaction): void }) {
      const own = useDismissalScope();
      scope = own;
      return (
        <DismissalScopeProvider scope={own}>
          <Probe onBegin={onBegin} pressEarly />
        </DismissalScopeProvider>
      );
    }
    const { begun } = mount(
      sessionDouble({}, { identity: identityStore(A) }),
      (onBegin) => <Dialog onBegin={onBegin} />,
      true,
    );
    const x = begun[0] as Interaction;
    expect(live(x).current).toBe(true);
    act(() => scope?.dismiss());
    expect(live(x)).toEqual({ current: false, withdrawn: true });
  });

  test("an identity change makes the interaction not current at once (the same identity again is no change)", () => {
    const identity = identityStore(A);
    const { begun } = mount(
      sessionDouble({}, { identity }),
      (onBegin) => <Probe onBegin={onBegin} pressEarly />,
      true,
    );
    const x = begun[0] as Interaction;
    act(() => identity.set({ ...A }));
    expect(live(x).current).toBe(true);
    act(() => identity.set({ ...A, account_id: "other" }));
    expect(live(x).current).toBe(false);
  });
});
