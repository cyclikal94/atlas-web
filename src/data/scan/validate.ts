import { DATA_CONFIG, type DataConfig } from "../model/config";
import { isAllocationError } from "../model/sizing";
import {
  type CacheRow,
  type JsonObject,
  RESOURCE_KINDS,
  type ResourceKind,
} from "../model/types";
import { codePointCount } from "./code-points";

/**
 * Pass 2 of bounded processing (plan 5.4.4): decode ONE change element, validate its envelope and the projection's base fields,
 * apply the shape gate, and return the cache row (or the id to remove). One element at a time, inside the commit transaction, so
 * the working set is one element, never the page.
 *
 * Every refusal is a fixed-shape `PageInvalid` with a stage and a reason from a CLOSED vocabulary. The text of the document, a
 * value, a validator's own issue list: none of it is read into the failure, stored or logged (A:3348-3373).
 */
export class PageInvalid extends Error {
  constructor(
    readonly stage: "element" | "envelope" | "projection" | "value" | "gate",
    readonly reason: string,
  ) {
    super(`${stage}:${reason}`);
    this.name = "PageInvalid";
  }
}

export type DecodedChange =
  | { kind: "upsert"; row: CacheRow }
  | { kind: "remove"; id: string };

/** Registries filled by the feature slices (WEB-10 to WEB-14). The envelope, base fields and gate are built here. */
export interface ValueValidatorRegistry {
  register(kind: ResourceKind, validator: (value: unknown) => boolean): void;
  validate(kind: ResourceKind, value: unknown): boolean;
}
export interface KeyDeriverRegistry {
  register(kind: ResourceKind, derive: (row: CacheRow) => string | null): void;
  derive(row: CacheRow): string | null;
}

export function createValueValidators(): ValueValidatorRegistry {
  const validators = new Map<ResourceKind, (value: unknown) => boolean>();
  return {
    register: (kind, validator) => {
      validators.set(kind, validator);
    },
    validate: (kind, value) => validators.get(kind)?.(value) ?? true,
  };
}
export function createKeyDerivers(): KeyDeriverRegistry {
  const derivers = new Map<ResourceKind, (row: CacheRow) => string | null>();
  return {
    register: (kind, derive) => {
      derivers.set(kind, derive);
    },
    derive: (row) => derivers.get(row.kind)?.(row) ?? null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: ReadonlySet<string> = new Set(RESOURCE_KINDS);
const PROJECTION_REQUIRED = [
  "id",
  "kind",
  "parent_id",
  "label",
  "value",
  "version",
  "can_edit",
  "archived",
] as const;
const PROJECTION_ALLOWED: ReadonlySet<string> = new Set([
  ...PROJECTION_REQUIRED,
  "policy_version",
]);

const decoder = new TextDecoder("utf-8", { fatal: true });

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isVersion = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

export interface DecodeDeps {
  validators: ValueValidatorRegistry;
  derivers: KeyDeriverRegistry;
  config?: Pick<DataConfig, "maxChangeBytes" | "maxValueNodes">;
}

export function decodeChange(
  bytes: Uint8Array,
  start: number,
  end: number,
  nodes: number,
  deps: DecodeDeps,
): DecodedChange {
  const config = deps.config ?? DATA_CONFIG;
  if (end - start > config.maxChangeBytes)
    throw new PageInvalid("gate", "element_too_large");
  if (nodes > config.maxValueNodes)
    throw new PageInvalid("gate", "too_many_nodes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes.subarray(start, end)));
  } catch (error) {
    // An allocation failure while decoding a valid element is not a fault of the page (R44): it leaves as itself, so that the commit
    // reports it as one (the ladder steps down) and not as invalid data (the unrecognised-response budget).
    if (isAllocationError(error)) throw error;
    // Invalid UTF-8 inside a string, or a syntax fault the scan did not see: either way the page is not what the contract says.
    throw new PageInvalid("element", "not_decodable");
  }
  if (!isPlainObject(parsed))
    throw new PageInvalid("envelope", "not_an_object");
  const keys = Object.keys(parsed);

  if (parsed.kind === "remove") {
    if (keys.length !== 2 || !("id" in parsed))
      throw new PageInvalid("envelope", "bad_remove");
    if (typeof parsed.id !== "string" || !UUID.test(parsed.id))
      throw new PageInvalid("envelope", "bad_id");
    return { kind: "remove", id: parsed.id };
  }
  if (parsed.kind !== "upsert")
    throw new PageInvalid("envelope", "unknown_kind");
  if (keys.length !== 2 || !isPlainObject(parsed.resource))
    throw new PageInvalid("envelope", "bad_upsert");

  const p = parsed.resource;
  for (const key of Object.keys(p))
    if (!PROJECTION_ALLOWED.has(key))
      throw new PageInvalid("projection", "unknown_field");
  for (const key of PROJECTION_REQUIRED)
    if (!(key in p)) throw new PageInvalid("projection", "missing_field");

  if (typeof p.id !== "string" || !UUID.test(p.id))
    throw new PageInvalid("projection", "bad_id");
  if (typeof p.kind !== "string" || !KINDS.has(p.kind))
    throw new PageInvalid("projection", "bad_kind");
  if (
    p.parent_id !== null &&
    (typeof p.parent_id !== "string" || !UUID.test(p.parent_id))
  )
    throw new PageInvalid("projection", "bad_parent");
  if (typeof p.label !== "string")
    throw new PageInvalid("projection", "bad_label");
  const labelLength = codePointCount(p.label);
  if (labelLength < 1 || labelLength > 300)
    throw new PageInvalid("projection", "bad_label");
  if (p.value !== null && !isPlainObject(p.value))
    throw new PageInvalid("projection", "bad_value");
  if (!isVersion(p.version)) throw new PageInvalid("projection", "bad_version");
  if (typeof p.can_edit !== "boolean")
    throw new PageInvalid("projection", "bad_can_edit");
  if (typeof p.archived !== "boolean")
    throw new PageInvalid("projection", "bad_archived");
  if ("policy_version" in p && !isVersion(p.policy_version))
    throw new PageInvalid("projection", "bad_policy_version");

  const kind = p.kind as ResourceKind;
  let valueOk: boolean;
  try {
    valueOk = deps.validators.validate(kind, p.value);
  } catch (error) {
    // A registrant's allocation failure is the device's, like any other (R44); the rest of its defects are not a storage fault, and
    // its message is never read (it could hold content).
    if (isAllocationError(error)) throw error;
    throw new PageInvalid("value", "validator_failed");
  }
  if (!valueOk) throw new PageInvalid("value", "rejected_by_kind");

  const row: CacheRow = {
    id: p.id,
    kind,
    parent_id: p.parent_id as string | null,
    label: p.label,
    value: p.value as JsonObject | null,
    version: p.version,
    can_edit: p.can_edit,
    archived: p.archived,
    kind_date: null,
    ...("policy_version" in p
      ? { policy_version: p.policy_version as number }
      : {}),
  };
  row.kind_date = deps.derivers.derive(row);
  return { kind: "upsert", row };
}
