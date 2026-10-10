import {
  type CapturedHousehold,
  type DefaultTemplate,
  householdsNamedBy,
  type SnapshotHousehold,
  type TemplateKind,
} from "../../../data";

/**
 * The defaults' resolution chain (WF-SHARING-03; docs/sharing.md, Defaults and explicit choices). PURE.
 *
 * application → primary household → personal → explicit per-record policy. A template at version 0 is MISSING and inherits the next layer:
 * it is a valid state, never "Private". The chain highlights the layer that actually resolves (R4 fix: the two layers must never describe
 * each other's values). Editing a template never changes existing records.
 */
export type Layer = "application" | "household" | "personal";

/** The application layer (docs/sharing.md, and `GET /defaults`'s description): people shared with the primary household (edit). */
export const APPLICATION_DEFAULTS: Readonly<
  Record<TemplateKind, DefaultTemplate>
> = {
  person: { kind: "primary_household", edit: true },
  field: { kind: "private" },
  task: { kind: "private" },
  list: { kind: "private" },
  progress: { kind: "primary_household", edit: false },
};

/** One layer's stored template, as `GET /defaults/templates` returns it: `template: null` (or version 0) is a MISSING template. */
export interface LayerRecord {
  template: DefaultTemplate | null;
  version: number;
}
const present = (
  record: LayerRecord | null,
): record is LayerRecord & {
  template: DefaultTemplate;
} => record !== null && record.version > 0 && record.template !== null;

/** Which layer resolves: personal when its template exists, else the primary household's, else the application's. */
export function resolvingLayer(input: {
  personal: LayerRecord | null;
  household: LayerRecord | null;
  primaryHouseholdId: string | null;
}): Layer {
  if (present(input.personal)) return "personal";
  if (input.primaryHouseholdId !== null && present(input.household))
    return "household";
  return "application";
}

export const KIND_LABEL: Readonly<Record<TemplateKind, string>> = {
  person: "People",
  field: "Fields",
  task: "Tasks",
  list: "Lists",
  progress: "Progress",
};

/** The sharing a review section is about, by kind ("Task sharing", "Progress sharing": WEB-04 §5.7 item 2). */
export const KIND_SHARING: Readonly<Record<TemplateKind, string>> = {
  person: "People sharing",
  field: "Field sharing",
  task: "Task sharing",
  list: "List sharing",
  progress: "Progress sharing",
};

export interface TemplateDescription {
  /** One line: what new records of this kind resolve to. */
  summary: string;
  /** Every household the template names, with its members as the snapshot lists them (or `unavailable`). */
  households: Array<
    | {
        id: string;
        name: string;
        members: Array<{ id: string; username: string }>;
      }
    | { id: string; unavailable: true }
  >;
  /** Accounts the template grants directly, by id. */
  accounts: Array<{ id: string; edit: boolean }>;
  excluded: string[];
}

const access = (edit: boolean) => (edit ? "edit" : "read");

export function describeTemplate(
  template: DefaultTemplate,
  primaryHouseholdId: string | null,
  households: ReadonlyArray<SnapshotHousehold | CapturedHousehold>,
): TemplateDescription {
  const resolve = (id: string): TemplateDescription["households"][number] => {
    const found = households.find((h) => h.id === id);
    if (found === undefined || "unavailable" in found)
      return { id, unavailable: true };
    return {
      id,
      name: found.name,
      members: found.members.map((m) => ({
        id: m.account_id,
        username: m.username,
      })),
    };
  };
  const named = householdsNamedBy(template, primaryHouseholdId).map(resolve);
  switch (template.kind) {
    case "private":
      return { summary: "Private", households: [], accounts: [], excluded: [] };
    case "primary_household": {
      if (primaryHouseholdId === null)
        return {
          summary: "Private (no primary household)",
          households: [],
          accounts: [],
          excluded: [],
        };
      const home = named[0];
      const name =
        home && "name" in home ? `“${home.name}”` : "your primary household";
      return {
        summary: `Primary household ${name} · ${access(template.edit)}`,
        households: named,
        accounts: [],
        excluded: [],
      };
    }
    case "explicit": {
      const accounts = template.policy.grants
        .filter((grant) => grant.kind === "account")
        .map((grant) => ({ id: grant.id, edit: grant.edit }));
      const parts: string[] = [];
      if (named.length > 0)
        parts.push(`${named.length} household${named.length === 1 ? "" : "s"}`);
      if (accounts.length > 0)
        parts.push(
          `${accounts.length} account${accounts.length === 1 ? "" : "s"}`,
        );
      return {
        summary:
          parts.length === 0
            ? "Explicit: nobody else"
            : `Explicit: ${parts.join(" and ")}`,
        households: named,
        accounts,
        excluded: [...template.policy.exclude_accounts],
      };
    }
  }
}

/** The template that resolves, and its layer: never one layer's value shown as another's. */
export function effectiveTemplate(input: {
  kind: TemplateKind;
  personal: LayerRecord | null;
  household: LayerRecord | null;
  primaryHouseholdId: string | null;
}): { layer: Layer; template: DefaultTemplate } {
  const layer = resolvingLayer(input);
  if (layer === "personal" && present(input.personal))
    return { layer, template: input.personal.template };
  if (layer === "household" && present(input.household))
    return { layer, template: input.household.template };
  return { layer: "application", template: APPLICATION_DEFAULTS[input.kind] };
}
