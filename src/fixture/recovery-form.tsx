import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { useFormRecoveryPort } from "../data";
import {
  RecoveryBanner,
  UNAVAILABLE_WHILE_RELOADING,
} from "../lib/form-recovery/RecoveryBanner";
import { pageFormRegistry } from "../lib/form-recovery/registry";
import { useRecoverableForm } from "../lib/form-recovery/use-recoverable-form";

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
 * feature form whose route or fields change would; followed by `__atlasRemountForm()` it is a remount with them.
 */
export const FIXTURE_FORM_CONTEXT = "fixture-note:/today";
const ALLOW = ["title", "notes"];

type FixtureProps = { formContext: string; allow: readonly string[] };
type FixtureScope = {
  __atlasRemountForm?: () => void;
  __atlasFormProps?: (props: Partial<FixtureProps>) => void;
  __atlasSubmitGate?: Promise<unknown>;
  __atlasFormMounts?: number;
};

export function FixtureRecoveryForm() {
  const [key, setKey] = useState(0);
  const [props, setProps] = useState<FixtureProps>({
    formContext: FIXTURE_FORM_CONTEXT,
    allow: ALLOW,
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

function FixtureRecoveryFormMount({ formContext, allow }: FixtureProps) {
  const port = useFormRecoveryPort();
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
      data-port={port ? "open" : "none"}
      data-submitted={submitted}
      data-locked={recovery.locked ? "true" : "false"}
      data-form-context={formContext}
      className="m-4 flex flex-col gap-3"
    >
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
              <Button
                key={copy.tabInstanceId}
                onClick={() => recovery.restoreAlternative(copy.tabInstanceId)}
              >
                {`Restore the copy saved ${copy.savedAt}`}
              </Button>
            ),
          )}
        </div>
      ) : null}
      <form
        ref={form}
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
        <label className="flex flex-col gap-1">
          Title
          <input ref={first} name="title" defaultValue="" />
        </label>
        <label className="flex flex-col gap-1">
          Notes
          <textarea name="notes" defaultValue="" />
        </label>
        <label className="flex flex-col gap-1">
          Password
          <input name="password" type="password" defaultValue="" />
        </label>
        <div>
          <Button type="submit">Save note</Button>
        </div>
      </form>
    </section>
  );
}
