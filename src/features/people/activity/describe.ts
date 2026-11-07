import type { ActivityAccount, PersonActivityEvent } from "../model/activity";
import * as copy from "./copy";

/**
 * WEB-19 (D-19-5): the sentence of one activity event, written by the client from its `type` (the contract's `summary` is checked, never
 * shown: presentation belongs to the client). PURE.
 *
 *  - The actor is "You", the account's username (the person's current owner or linked account: the only ones the server names), or
 *    "Someone else" (anyone else; two of them are indistinguishable, and nothing here tries to tell them apart).
 *  - An item is named by its CURRENT label (`target.label`, the only label the server keeps): a rename says "changed the name of ‹label›"
 *    and never presents the label shown as the earlier one. No earlier name, label or value exists to show (the timeline-first policy).
 *  - The person the reader is on is "this person"; another person (a profile merged into it) is named, and tagged by the view.
 */
export type ActivityPart =
  | { kind: "text"; text: string }
  /** `of`: the event's target (linked and tagged by the view) or the profile merged in (named only). */
  | { kind: "item"; label: string; of: "target" | "source" };

export interface ActivityDescription {
  actor: string;
  /** What follows the actor, in order, each with its position as a stable key (a sentence's parts never move). */
  parts: Array<ActivityPart & { key: string }>;
}

export function actorName(account: ActivityAccount): string {
  switch (account.kind) {
    case "you":
      return copy.ACTOR_YOU;
    case "account":
      return account.username;
    case "someone_else":
      return copy.ACTOR_SOMEONE_ELSE;
  }
}

/** The linked (or previously linked) account as said after `actor` acted. */
export function accountPhrase(
  account: ActivityAccount,
  actor: ActivityAccount,
): string {
  if (account.kind === "you") return copy.YOUR_ACCOUNT;
  if (account.kind === "someone_else") return copy.ANOTHER_ACCOUNT;
  if (actor.kind === "account" && actor.account_id === account.account_id)
    return copy.THEIR_ACCOUNT;
  return copy.ACCOUNT_OF(account.username);
}

const text = (value: string): ActivityPart => ({ kind: "text", text: value });

export function describeActivity(
  event: PersonActivityEvent,
  context: { personId: string },
): ActivityDescription {
  const actor = actorName(event.actor);
  const target: ActivityPart = {
    kind: "item",
    label: event.target.label,
    of: "target",
  };
  // A person event about the person the reader is on says "this person"; about a profile merged into it, it names that profile.
  const here =
    event.target.kind === "person" && event.target.id === context.personId;
  const subject = (): ActivityPart[] =>
    here ? [text(copy.THIS_PERSON)] : [target];
  const parts = ((): ActivityPart[] => {
    switch (event.type) {
      case "person_created":
        return [text(copy.VERB_ADDED), ...subject()];
      case "person_renamed":
        return here
          ? [text(copy.VERB_RENAMED), text(copy.THIS_PERSON)]
          : [text(copy.VERB_CHANGED_NAME), target];
      case "person_archived":
        return [text(copy.VERB_ARCHIVED), ...subject()];
      case "person_restored":
        return [text(copy.VERB_RESTORED), ...subject()];
      case "person_linked":
        return [
          text(copy.VERB_LINKED),
          ...subject(),
          text(
            copy.TO_ACCOUNT(
              accountPhrase(
                event.account ?? { kind: "someone_else" },
                event.actor,
              ),
            ),
          ),
        ];
      case "person_unlinked":
        return [
          text(copy.VERB_UNLINKED),
          ...subject(),
          text(
            copy.FROM_ACCOUNT(
              accountPhrase(
                event.account ?? { kind: "someone_else" },
                event.actor,
              ),
            ),
          ),
        ];
      case "person_merged":
        return [
          text(copy.VERB_MERGED),
          event.merged_from === undefined
            ? text(copy.ANOTHER_PROFILE)
            : { kind: "item", label: event.merged_from.label, of: "source" },
          text(copy.INTO),
          ...subject(),
        ];
      case "field_created":
        return [text(copy.VERB_ADDED), target];
      case "field_edited": {
        const changed = new Set(event.changed ?? []);
        const verb =
          changed.has("label") && changed.has("value")
            ? copy.VERB_CHANGED_NAME_AND_VALUE
            : changed.has("label")
              ? copy.VERB_CHANGED_NAME
              : copy.VERB_CHANGED_VALUE;
        return [text(verb), target];
      }
      case "field_archived":
        return [text(copy.VERB_ARCHIVED), target];
      case "field_restored":
        return [text(copy.VERB_RESTORED), target];
    }
  })();
  return {
    actor,
    parts: parts.map((part, at) => ({ ...part, key: `part-${at}` })),
  };
}

/** The whole sentence as plain text (an accessible name, a test's expectation): the parts joined by spaces, with a full stop. */
export function sentenceOf(description: ActivityDescription): string {
  return `${[description.actor, ...description.parts.map((part) => (part.kind === "text" ? part.text : part.label))].join(" ")}.`;
}
