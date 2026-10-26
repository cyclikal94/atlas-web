import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import type { Policy } from "../../data";
import { AudienceSummary } from "./AudienceSummary";
import * as copy from "./copy";
import { DirectoryLookup } from "./DirectoryLookup";
import { SharingBoundary, useSharingEnv } from "./env";
import { knownMembership, useMembership } from "./membership";
import { effectiveAudience, labelsFrom } from "./model/audience";
import {
  type PolicyAction,
  type PolicyRefusal,
  reducePolicy,
} from "./model/policy-draft";
import { PolicyGrantsEditor } from "./PolicyGrantsEditor";
import { formatWhen } from "./parts";

/** Private: an explicit empty policy. Kept here: `copy.ts` is part of the shell's first load, and this module is not. */
const ONLY_ME = "Only me (private)";

/**
 * A policy CHOOSER for a caller that sends the policy itself (WEB-12a's public interface; WEB-10a revision 10, R22: the audience of a task
 * enrolment). The same presentation as WF-SHARING-04 (the effective audience, the grant and exclusion editor, the directory lookup) over a
 * policy the CALLER owns: every edit is handed to `onChange`, and nothing is read or sent about any resource's policy here. Only the
 * households you are in are read (`GET /households`, for names and the household picker).
 *
 * `blocked` (revision 11, R23): why nothing can be edited now (the caller is sending or confirming its policy), or null. It holds everywhere
 * in the chooser, an open directory lookup included (its Choose buttons say why), and is checked again when an edit happens.
 */
export interface AudienceChooserProps {
  policy: Policy;
  onChange(policy: Policy): void;
  blocked: string | null;
}

export function AudienceChooser(props: AudienceChooserProps) {
  return (
    <SharingBoundary>
      <Chooser {...props} />
    </SharingBoundary>
  );
}

function Chooser({ policy, onChange, blocked }: AudienceChooserProps) {
  const disabled = blocked !== null;
  const env = useSharingEnv();
  const [membership, retryMembership] = useMembership({
    enabled: env.online,
    read: () => env.api.readHouseholds(),
    now: env.now,
    target: [env.api],
  });
  const known = knownMembership(membership);
  const [learnt, setLearnt] = useState<Array<[string, string]>>([]);
  const [refused, setRefused] = useState<PolicyRefusal | null>(null);
  const [view, setView] = useState<"edit" | "grant" | "exclude">("edit");
  const labels = useMemo(
    () => labelsFrom(known?.households ?? [], learnt),
    [known, learnt],
  );
  const dispatch = (action: PolicyAction) => {
    if (disabled) return;
    const next = reducePolicy({ policy, refused: null }, action, env.accountId);
    setRefused(next.refused);
    if (next.policy !== policy) onChange(next.policy);
  };
  if (view !== "edit")
    return (
      <DirectoryLookup
        purpose={
          view === "grant"
            ? copy.ADD_ACCOUNT.slice(2)
            : copy.ADD_EXCLUSION.slice(2)
        }
        onBack={() => setView("edit")}
        blocked={blocked}
        onChoose={(entry) => {
          if (disabled) return;
          setLearnt((all) => [...all, [entry.id, entry.username]]);
          dispatch(
            view === "grant"
              ? { type: "add_account", id: entry.id }
              : { type: "exclude", id: entry.id },
          );
          setView("edit");
        }}
      />
    );
  return (
    <div className="flex flex-col gap-3" data-audience-chooser="">
      <AudienceSummary
        audience={effectiveAudience({
          ownerId: env.accountId,
          policy,
          households: known?.households ?? [],
          complete: membership.status === "ready",
          labels,
          parentLimited: false,
        })}
        membersAsOf={known ? formatWhen(known.at, env.now()) : null}
        parentLabel={null}
      />
      {disabled ? null : (
        <span>
          <Button
            variant="ghost"
            onClick={() =>
              dispatch({
                type: "reset",
                policy: { grants: [], exclude_accounts: [] },
              })
            }
          >
            {ONLY_ME}
          </Button>
        </span>
      )}
      <PolicyGrantsEditor
        policy={policy}
        labels={labels}
        membership={membership}
        onRetryMembership={retryMembership}
        disabled={disabled}
        refused={refused}
        dispatch={dispatch}
        onLookup={(purpose) => setView(purpose)}
      />
    </div>
  );
}
