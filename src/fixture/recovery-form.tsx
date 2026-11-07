import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { useFormRecoveryPort } from "../data";
import { HANDOFF_PREFIX } from "../lib/form-recovery/handoff";
import type { FormRecoveryPort } from "../lib/form-recovery/port";
import {
  RecoveryBanner,
  UNAVAILABLE_WHILE_RELOADING,
} from "../lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../lib/form-recovery/registry";
import {
  isHandoff,
  useRecoverableForm,
} from "../lib/form-recovery/use-recoverable-form";

// FIXTURE: the page's registry of recoverable forms, for a spec to read what the app-update coordinator sees.
(window as unknown as { __atlasForms?: typeof pageFormRegistry }).__atlasForms =
  pageFormRegistry;

/**
 * FIXTURE ONLY (WEB-14a). The recoverable form the PWA browser checks drive (P-U3, P-U5): the `/__session` harness mounts it in the REAL
 * protected tree with `?form=1`, over the displayed account's real `form_recovery` store, using the contract feature slices will use
 * (`useFormRecoveryPort` + `useRecoverableForm` + WEB-07's `RecoveryBanner`). Submitting sends nothing anywhere: it takes a submission
 * ticket (revision 2: none while an update reload is prepared), "sends" (a fixture gate a spec may hold, `__atlasSubmitGate`), and on
 * success discards the copies as a real form does, recording that it happened. Its recovery controls outside the form are disabled while
 * the form is locked. No product form exists yet (WEB-10a onwards).
 *
 * TEST INJECTION: `__atlasRemountForm()` mounts the form again in its place (a new key), as another page's boot does to the protected tree,
 * so a spec can force the remount schedule the peer boot only sometimes produces (revision 2, R2/R4). `__atlasFormProps({ formContext,
 * allow })` (revision 3, R10/R11) renders the SAME mount with another form context or allow-list (field names; never the password), as a
 * feature form whose route or fields change would; followed by `__atlasRemountForm()` it is a remount with them. Revision 4 (R11): `shown`
 * (field names) says which of the title and notes fields are ON THE PAGE, separately from what is admitted, as a conditional field that a
 * feature form hides would be; given with `allow` in one call, the field and its admission go in the same render. Revision 5 (R3):
 * `unbound` withholds the port from the form (as before the account's database is open), so a spec can type into a mount before it binds
 * the page's session (late binding); `unbound: false` gives it back. Revision 6 (R13): an alternative that is an update hand-off left by a
 * page that never came back also offers "Discard this copy" (the only way it is removed). TEST INJECTION (revision 6): with
 * `atlas-fixture-hold-form` set in the tab's session storage, the form of the NEXT page of the tab starts `unbound` (no recovery read
 * at all) until a spec gives the port back, so a spec can hold the page an update reload brings before its first recovery read without
 * touching any lock or the worker. TEST INJECTION (revision 7, R13): with `atlas-fixture-fail-handoff-read` set to "1" in the tab's session
 * storage when the form mounts, the form's FIRST read of an update hand-off (through the real port, pinned) is refused as an unreadable store
 * refuses it, and the flag is removed; every other read, and every write, is the real port's. Without the flag the port is not wrapped.
 * TEST INJECTION (revision 8, R17): with `atlas-fixture-choices` set to "1" in the tab's session storage when the form mounts, the form
 * also shows and admits a checkbox ("Pinned") and a multiple select ("Tags"), so a spec can carry choices across a real update.
 * TEST INJECTION (revision 9, R17): with choices, also a single select ("Priority"); `without` (option values) leaves those options out of
 * Tags and Priority, the select itself staying (as a feature form that narrows its options would), from `atlas-fixture-without` (a JSON
 * array in the tab's session storage, read when the form mounts) or `__atlasFormProps({ without })`.
 * TEST INJECTION (revision 10, R17 and R11): with `atlas-fixture-number` set to "1" in the tab's session storage when the form mounts, the
 * form also shows and admits a number field ("Count"), so a spec can carry an unfinished number entry into a real update; with
 * `atlas-fixture-admit` (a JSON array of field names) set when the form mounts, only those fields are admitted AND shown, as a feature form
 * whose conditional fields start hidden would (`__atlasFormProps` shows the others again).
 * TEST INJECTION (revision 11, R18): with `atlas-fixture-external` set to "1" in the tab's session storage when the form mounts, the form
 * also admits a text field ("Place") shown OUTSIDE the form element and associated with it by its `form` attribute, as a feature form whose
 * layout puts a field beside the form would.
 */
const HOLD_KEY = "atlas-fixture-hold-form";
const CHOICES_KEY = "atlas-fixture-choices";
const FAIL_READ_KEY = "atlas-fixture-fail-handoff-read";
const WITHOUT_KEY = "atlas-fixture-without";
const NUMBER_KEY = "atlas-fixture-number";
const ADMIT_KEY = "atlas-fixture-admit";
const EXTERNAL_KEY = "atlas-fixture-external";
const FORM_ID = "fixture-note-form";

/** The real port, with its first hand-off read refused (TEST INJECTION, above); one wrapper per port, so a pinned port stays the same. */
const injected = new WeakMap<FormRecoveryPort, FormRecoveryPort>();
function failingFirstHandoffRead(port: FormRecoveryPort): FormRecoveryPort {
  const known = injected.get(port);
  if (known) return known;
  const wrapped: FormRecoveryPort = {
    save: (snapshot) => port.save(snapshot),
    discard: (formContext, id, capture) =>
      port.discard(formContext, id, capture),
    list: (formContext) => port.list(formContext),
    load: (formContext, id) => {
      if (
        formContext.startsWith(HANDOFF_PREFIX) &&
        sessionStorage.getItem(FAIL_READ_KEY) === "1"
      ) {
        sessionStorage.removeItem(FAIL_READ_KEY);
        return Promise.reject(
          new Error("TEST INJECTION: the hand-off read failed"),
        );
      }
      return port.load(formContext, id);
    },
    ...(port.pin
      ? {
          pin: () => {
            const pinned = port.pin?.() ?? null;
            return pinned
              ? { ...pinned, port: failingFirstHandoffRead(pinned.port) }
              : null;
          },
        }
      : {}),
  };
  injected.set(port, wrapped);
  return wrapped;
}
export const FIXTURE_FORM_CONTEXT = "fixture-note:/today";
const OPTIONS = {
  tags: ["home", "work", "later"],
  priority: ["low", "normal", "high"],
};
const ALLOW = ["title", "notes"];

type FixtureProps = {
  formContext: string;
  allow: readonly string[];
  shown: readonly string[];
  unbound?: boolean;
  without?: readonly string[];
};
type FixtureScope = {
  __atlasRemountForm?: () => void;
  __atlasFormProps?: (props: Partial<FixtureProps>) => void;
  __atlasSubmitGate?: Promise<unknown>;
  __atlasFormMounts?: number;
};

export function FixtureRecoveryForm() {
  const [key, setKey] = useState(0);
  const [props, setProps] = useState<FixtureProps>(() => {
    const all = [
      ...ALLOW,
      ...(sessionStorage.getItem(CHOICES_KEY) === "1"
        ? ["pinned", "tags", "priority"]
        : []),
      ...(sessionStorage.getItem(NUMBER_KEY) === "1" ? ["count"] : []),
      ...(sessionStorage.getItem(EXTERNAL_KEY) === "1" ? ["place"] : []),
    ];
    const admit: unknown = JSON.parse(
      sessionStorage.getItem(ADMIT_KEY) ?? "null",
    );
    const fields = Array.isArray(admit)
      ? all.filter((name) => admit.includes(name))
      : all;
    return {
      formContext: FIXTURE_FORM_CONTEXT,
      allow: fields,
      shown: fields,
      unbound: sessionStorage.getItem(HOLD_KEY) === "1",
      without: JSON.parse(sessionStorage.getItem(WITHOUT_KEY) ?? "[]"),
    };
  });
  useEffect(() => {
    const scope = window as unknown as FixtureScope;
    scope.__atlasRemountForm = () => setKey((n) => n + 1);
    scope.__atlasFormProps = (next) =>
      setProps((current) => ({ ...current, ...next }));
    return () => {
      scope.__atlasRemountForm = undefined;
      scope.__atlasFormProps = undefined;
    };
  }, []);
  return <FixtureRecoveryFormMount key={key} {...props} />;
}

function FixtureRecoveryFormMount({
  formContext,
  allow,
  shown,
  unbound,
  without = [],
}: FixtureProps) {
  const opened = useFormRecoveryPort();
  const [failRead] = useState(
    () => sessionStorage.getItem(FAIL_READ_KEY) === "1",
  );
  const reaching = useMemo(
    () => (opened && failRead ? failingFirstHandoffRead(opened) : opened),
    [opened, failRead],
  );
  const port = unbound ? null : reaching;
  const form = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement>(null);
  const [submitted, setSubmitted] = useState(0);
  const recovery = useRecoverableForm({
    formContext,
    allow: allow.map((name) => ({ name })),
    formRef: form,
    port,
  });
  // FIXTURE: how many times this form has been mounted in the page (a spec checks a forced remount really happened).
  useEffect(() => {
    const scope = window as unknown as FixtureScope;
    scope.__atlasFormMounts = (scope.__atlasFormMounts ?? 0) + 1;
  }, []);
  return (
    <section
      aria-label="Fixture recovery form"
      data-fixture-form=""
      data-ready={recovery.ready ? "true" : "false"}
      data-unavailable={recovery.unavailable ? "true" : "false"}
      data-port={port ? "open" : "none"}
      data-submitted={submitted}
      data-locked={recovery.locked ? "true" : "false"}
      data-form-context={formContext}
      data-incomplete={recovery.incomplete.join(" ")}
      className="m-4 flex flex-col gap-3"
    >
      {recovery.unavailable ? (
        <RecoveryBanner
          state={{ kind: "unavailable", onRetry: () => void recovery.retry() }}
        />
      ) : null}
      {recovery.restored ? (
        <RecoveryBanner
          state={{
            kind: "restored",
            onDiscard: () => void recovery.discard(),
            disabled: recovery.locked,
          }}
          firstFieldRef={first}
        />
      ) : null}
      {recovery.alternatives.length > 0 ? (
        <div data-alternatives={recovery.alternatives.length}>
          <p>Other saved copies of this form:</p>
          {recovery.alternatives.map((copy) =>
            recovery.locked ? (
              <Button
                key={copy.tabInstanceId}
                disabled
                reason={UNAVAILABLE_WHILE_RELOADING}
              >
                {`Restore the copy saved ${copy.savedAt}`}
              </Button>
            ) : (
              <span key={copy.tabInstanceId} data-handoff={isHandoff(copy)}>
                <Button
                  onClick={() =>
                    void recovery.restoreAlternative(copy.tabInstanceId)
                  }
                >
                  {`Restore the copy saved ${copy.savedAt}`}
                </Button>
                {isHandoff(copy) ? (
                  <Button
                    variant="quiet"
                    onClick={() =>
                      void recovery.discardAlternative(copy.tabInstanceId)
                    }
                  >
                    {`Discard the copy saved ${copy.savedAt}`}
                  </Button>
                ) : null}
              </span>
            ),
          )}
        </div>
      ) : null}
      <form
        ref={form}
        id={FORM_ID}
        aria-label="Fixture note"
        onSubmit={(event) => {
          event.preventDefault();
          // Taken BEFORE "sending": an update reload prepared meanwhile waits for it (revision 2, R3); none while one is prepared.
          const ticket = recovery.submitting();
          if (!ticket) return;
          const sent =
            (window as unknown as FixtureScope).__atlasSubmitGate ??
            Promise.resolve();
          void sent.then(
            () => ticket.succeeded().then(() => setSubmitted((n) => n + 1)),
            () => ticket.failed(),
          );
        }}
        className="flex flex-col gap-2"
      >
        {shown.includes("title") ? (
          <label className="flex flex-col gap-1">
            Title
            <input ref={first} name="title" defaultValue="" />
          </label>
        ) : null}
        {shown.includes("notes") ? (
          <label className="flex flex-col gap-1">
            Notes
            <textarea name="notes" defaultValue="" />
          </label>
        ) : null}
        {shown.includes("pinned") ? (
          <label className="flex items-center gap-2">
            <input name="pinned" type="checkbox" value="yes" />
            Pinned
          </label>
        ) : null}
        {shown.includes("tags") ? (
          <label className="flex flex-col gap-1">
            Tags
            <select name="tags" multiple defaultValue={["home"]}>
              {OPTIONS.tags
                .filter((value) => !without.includes(value))
                .map((value) => (
                  <option key={value} value={value}>
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {shown.includes("priority") ? (
          <label className="flex flex-col gap-1">
            Priority
            <select name="priority" defaultValue="normal">
              {OPTIONS.priority
                .filter((value) => !without.includes(value))
                .map((value) => (
                  <option key={value} value={value}>
                    {value[0]?.toUpperCase()}
                    {value.slice(1)}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {shown.includes("count") ? (
          <label className="flex flex-col gap-1">
            Count
            <input name="count" type="number" defaultValue="" />
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          Password
          <input name="password" type="password" defaultValue="" />
        </label>
        <div>
          <Button type="submit">Save note</Button>
        </div>
      </form>
      {shown.includes("place") ? (
        <label className="flex flex-col gap-1">
          Place
          <input name="place" form={FORM_ID} defaultValue="" />
        </label>
      ) : null}
    </section>
  );
}
