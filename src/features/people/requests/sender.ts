import { useSharingDefaults } from "../../../data";
import type { PeopleEnv } from "../env";
import { senderName } from "../model/requests";
import type { PersonSummary } from "../model/summary";

/**
 * Who sent a request (D-11b-5, a DISCLOSED limitation: the contract's incoming request carries no username, and there is no reverse
 * lookup from an account id, E-2b). Only what this page already holds is used: the account's B5 snapshot of its households (members'
 * usernames), then the people summaries this page read whose owner is the sender. Null: Atlas cannot name them (the row says so and
 * cautions the reader). An account id is never shown.
 */
export function useSenderName(
  env: PeopleEnv,
  senderId: string | null,
): string | null {
  const defaults = useSharingDefaults();
  if (senderId === null) return null;
  return senderName(
    senderId,
    defaults.record?.snapshot.households ?? [],
    summariesIn(env),
  );
}

/** Every person summary the page's memory holds now (the lists' walks and the people's own summaries). */
function* summariesIn(env: PeopleEnv): Generator<PersonSummary> {
  for (const entry of env.memory.summaries.values()) {
    if (entry.state.kind !== "ready") continue;
    const value = entry.state.value as {
      read?: unknown;
      summary?: unknown;
    } | null;
    if (value === null || typeof value !== "object") continue;
    if (value.read instanceof Map)
      for (const item of value.read.values()) {
        const summary = item as Partial<PersonSummary>;
        if (summary.owner !== undefined && "label" in summary)
          yield summary as PersonSummary;
      }
    const one = value.summary as Partial<PersonSummary> | undefined;
    if (one !== undefined && one.owner !== undefined)
      yield one as PersonSummary;
  }
}
