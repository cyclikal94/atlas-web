import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { List } from "../../components/ui/list";
import type { Policy, PrincipalGrant } from "../../data";
import * as copy from "./copy";
import { useSharingEnv } from "./env";
import { knownMembership, type Membership } from "./membership";
import type { PolicyAction, PolicyRefusal } from "./model/policy-draft";
import { Banner, ChoiceGroup } from "./parts";

/**
 * The grant and exclusion editor shared by WF-SHARING-04 (a resource's policy) and WF-SHARING-03 (an explicit template): account grants,
 * household grants and exclusions, each with its add and remove controls and a Read/Edit radio group per grant. "+ Add account grant"
 * and "+ Add exclusion" open the directory lookup (the caller swaps the view); "+ Add household grant" offers the households you are in.
 * A household you are not in (named by a policy someone else shared with you) is shown as such.
 *
 * "The households you are in" is the caller's COMPLETE membership list (`GET /households`, WEB-12a R11), never the B5 record's subset.
 * Only a complete list of the latest read offers households to add or says a household is one you are not in. While it is loading or
 * couldn't be loaded, adding a household waits (the button says why), a granted household keeps the name the last list gave it or is
 * shown neutrally, and a failure offers its own Try again. Nothing already granted is removed or changed by any of this.
 */
export function PolicyGrantsEditor({
  policy,
  labels,
  membership,
  onRetryMembership,
  disabled,
  refused,
  dispatch,
  onLookup,
}: {
  policy: Policy;
  labels: ReadonlyMap<string, string>;
  /** The households you are in (their names, for labels and the picker), as the editor's own membership read has them. */
  membership: Membership;
  /** Reads the membership list again (its failure's Try again). */
  onRetryMembership(): void;
  disabled: boolean;
  refused: PolicyRefusal | null;
  dispatch(action: PolicyAction): void;
  onLookup(purpose: "grant" | "exclude"): void;
}) {
  const env = useSharingEnv();
  const ids = { accounts: useId(), households: useId(), excluded: useId() };
  const [picking, setPicking] = useState(false);
  const accounts = policy.grants.filter((g) => g.kind === "account");
  const householdGrants = policy.grants.filter((g) => g.kind === "household");
  const excluded = new Set(policy.exclude_accounts);
  // The complete list of the latest read, or null: only it can offer a household or say you are not in one.
  const complete =
    membership.status === "ready" ? membership.current.households : null;
  const known = knownMembership(membership)?.households ?? [];
  const nameOf = (grant: PrincipalGrant) =>
    grant.kind === "account"
      ? copy.accountLabel(grant.id, labels)
      : (known.find((h) => h.id === grant.id)?.name ??
        (complete !== null
          ? copy.HOUSEHOLD_UNKNOWN
          : copy.HOUSEHOLD_UNCHECKED));
  const addable = (complete ?? []).filter(
    (h) => !householdGrants.some((g) => g.id === h.id),
  );
  const addReason =
    complete !== null
      ? null
      : membership.status === "loading"
        ? copy.ADD_HOUSEHOLD_LOADING_REASON
        : !env.online
          ? copy.ADD_HOUSEHOLD_OFFLINE_REASON
          : copy.ADD_HOUSEHOLD_FAILED_REASON;

  const grantRow = (grant: PrincipalGrant) => {
    const name = nameOf(grant);
    return (
      <li
        key={`${grant.kind}:${grant.id}`}
        data-grant={grant.kind}
        data-principal={grant.id}
        className="flex list-none flex-wrap items-center gap-2 rounded-row border border-hairline-strong bg-panel px-3 py-2"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="break-words text-[13.5px] text-ink-1">{name}</span>
          {grant.kind === "account" && excluded.has(grant.id) ? (
            <span className="text-[12px] text-ink-2">
              {copy.ALREADY_EXCLUDED}
            </span>
          ) : null}
        </span>
        <ChoiceGroup<"read" | "edit">
          label={`${name}: ${copy.READ} or ${copy.EDIT}`}
          value={grant.edit ? "edit" : "read"}
          disabled={disabled}
          choices={[
            { value: "read", label: copy.READ },
            { value: "edit", label: copy.EDIT },
          ]}
          onChange={(value) =>
            dispatch({
              type: "set_edit",
              kind: grant.kind,
              id: grant.id,
              edit: value === "edit",
            })
          }
        />
        {disabled ? null : (
          <Button
            variant="quiet"
            aria-label={`${copy.REMOVE}: ${name}`}
            onClick={() =>
              dispatch({ type: "remove", kind: grant.kind, id: grant.id })
            }
          >
            {copy.REMOVE}
          </Button>
        )}
      </li>
    );
  };

  const refusal =
    refused === "owner"
      ? copy.REFUSED_OWNER
      : refused === "grant_limit"
        ? copy.REFUSED_GRANT_LIMIT
        : refused === "exclusion_limit"
          ? copy.REFUSED_EXCLUSION_LIMIT
          : null;

  return (
    <div className="flex flex-col gap-5" data-grants-editor="">
      {refusal ? (
        <p className="text-[12.5px] text-ink-1" data-policy-refusal="">
          {refusal}
        </p>
      ) : null}
      <section aria-labelledby={ids.accounts} className="flex flex-col gap-2">
        <h3 id={ids.accounts} className="text-[13.5px] font-medium text-ink-1">
          {copy.ACCOUNT_GRANTS}
        </h3>
        {accounts.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">{copy.NO_ACCOUNT_GRANTS}</p>
        ) : (
          <List className="flex flex-col gap-1.5">
            {accounts.map(grantRow)}
          </List>
        )}
        {disabled ? null : (
          <span>
            <Button variant="quiet" onClick={() => onLookup("grant")}>
              {copy.ADD_ACCOUNT}
            </Button>
          </span>
        )}
      </section>
      <section aria-labelledby={ids.households} className="flex flex-col gap-2">
        <h3
          id={ids.households}
          className="text-[13.5px] font-medium text-ink-1"
        >
          {copy.HOUSEHOLD_GRANTS}
        </h3>
        {householdGrants.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">{copy.NO_HOUSEHOLD_GRANTS}</p>
        ) : (
          <List className="flex flex-col gap-1.5">
            {householdGrants.map(grantRow)}
          </List>
        )}
        {membership.status === "loading" ? (
          <p className="text-[12.5px] text-ink-2" data-membership="loading">
            {copy.HOUSEHOLDS_LOADING}
          </p>
        ) : membership.status === "failed" ? (
          <div data-membership="failed">
            <Banner
              message={copy.HOUSEHOLDS_FAILED}
              requestId={
                "requestId" in membership.failure
                  ? membership.failure.requestId
                  : undefined
              }
              action={
                env.online ? (
                  <Button onClick={onRetryMembership}>{copy.TRY_AGAIN}</Button>
                ) : (
                  <Button disabled reason={copy.SAVE_OFFLINE_REASON}>
                    {copy.TRY_AGAIN}
                  </Button>
                )
              }
            />
          </div>
        ) : null}
        {disabled ? null : addReason !== null ? (
          <span>
            <Button variant="quiet" disabled reason={addReason}>
              {copy.ADD_HOUSEHOLD}
            </Button>
          </span>
        ) : picking ? (
          <div className="flex flex-col gap-1.5" data-household-picker="">
            <span className="text-[12.5px] text-ink-2">
              {copy.HOUSEHOLD_PICKER}
            </span>
            {addable.length === 0 ? (
              <p className="text-[12.5px] text-ink-2">
                {copy.NO_HOUSEHOLDS_TO_ADD}
              </p>
            ) : (
              <List className="flex flex-wrap gap-1.5">
                {addable.map((household) => (
                  <li key={household.id} className="list-none">
                    <Button
                      onClick={() => {
                        dispatch({ type: "add_household", id: household.id });
                        setPicking(false);
                      }}
                    >
                      {household.name}
                    </Button>
                  </li>
                ))}
              </List>
            )}
            <span>
              <Button variant="quiet" onClick={() => setPicking(false)}>
                {copy.CANCEL}
              </Button>
            </span>
          </div>
        ) : (
          <span>
            <Button variant="quiet" onClick={() => setPicking(true)}>
              {copy.ADD_HOUSEHOLD}
            </Button>
          </span>
        )}
      </section>
      <section aria-labelledby={ids.excluded} className="flex flex-col gap-2">
        <h3 id={ids.excluded} className="text-[13.5px] font-medium text-ink-1">
          {copy.EXCLUSIONS}
        </h3>
        {policy.exclude_accounts.length === 0 ? (
          <p className="text-[12.5px] text-ink-2">{copy.NO_EXCLUSIONS}</p>
        ) : (
          <List className="flex flex-col gap-1.5">
            {policy.exclude_accounts.map((id) => {
              const name = copy.accountLabel(id, labels);
              return (
                <li
                  key={id}
                  data-exclusion={id}
                  className="flex list-none flex-wrap items-center gap-2 rounded-row border border-hairline-strong bg-panel px-3 py-2"
                >
                  <span className="min-w-0 flex-1 break-words text-[13.5px] text-ink-1">
                    {name} — {copy.EXCLUDED_NOTE}
                  </span>
                  {disabled ? null : (
                    <Button
                      variant="quiet"
                      aria-label={`${copy.REMOVE_EXCLUSION}: ${name}`}
                      onClick={() => dispatch({ type: "include", id })}
                    >
                      {copy.REMOVE_EXCLUSION}
                    </Button>
                  )}
                </li>
              );
            })}
          </List>
        )}
        {disabled ? null : (
          <span>
            <Button variant="quiet" onClick={() => onLookup("exclude")}>
              {copy.ADD_EXCLUSION}
            </Button>
          </span>
        )}
      </section>
      <p className="text-[12px] leading-[1.55] text-ink-2">
        {copy.EXCLUSION_RULE}
      </p>
    </div>
  );
}
