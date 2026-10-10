import {
  type IndexSpec,
  KEY_PATHS,
  parseSchema,
  type StoreName,
} from "../../../src/data/model/schema";
import type { Key, KeyRange } from "../../../src/data/store/port";

/**
 * IndexedDB key ordering and index-key extraction, for the store double. Numbers sort before strings, arrays compare
 * element by element (the order IndexedDB defines for the key types the schema uses).
 */
const rank = (value: unknown): number =>
  typeof value === "number"
    ? 1
    : typeof value === "string"
      ? 3
      : Array.isArray(value)
        ? 4
        : 5;

export function compareKeys(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const c = compareKeys(a[index], b[index]);
      if (c !== 0) return c;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  return (a as number | string) < (b as number | string)
    ? -1
    : (a as number | string) > (b as number | string)
      ? 1
      : 0;
}

const isValidKey = (value: unknown): boolean =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every(isValidKey));

export const keyString = (key: Key): string => JSON.stringify(key);

/** The primary key of a row of a store (a compound key is an array). */
export function primaryKeyOf(store: StoreName, row: object): Key {
  const path = KEY_PATHS[store];
  const get = (p: string): unknown => (row as Record<string, unknown>)[p];
  const key = Array.isArray(path)
    ? (path as readonly string[]).map(get)
    : get(path as string);
  if (!isValidKey(key))
    throw new TypeError(`${store}: a row has no valid primary key`);
  return key as Key;
}

/** The index keys one row contributes to an index (none when a component is not a valid key; one per element when multi-entry). */
export function indexKeysOf(row: object, spec: IndexSpec): Key[] {
  // A key path may be nested (`retry_state.state`): a row is indexed only while the whole path resolves to a valid key, which is
  // what IndexedDB does (a null object has no value at the path).
  const get = (p: string): unknown =>
    p
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value !== null && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined,
        row,
      );
  if (Array.isArray(spec.keyPath)) {
    const key = (spec.keyPath as readonly string[]).map(get);
    return isValidKey(key) ? [key as Key] : [];
  }
  const value = get(spec.keyPath as string);
  if (spec.multiEntry && Array.isArray(value)) {
    const unique = new Map<string, Key>();
    for (const element of value)
      if (isValidKey(element))
        unique.set(JSON.stringify(element), element as Key);
    return [...unique.values()];
  }
  return isValidKey(value) ? [value as Key] : [];
}

export function inRange(key: Key, range: KeyRange): boolean {
  if (range.kind === "all") return true;
  if (range.kind === "only") return compareKeys(key, range.value) === 0;
  if (range.lower !== undefined) {
    const c = compareKeys(key, range.lower);
    if (c < 0 || (c === 0 && range.lowerOpen)) return false;
  }
  if (range.upper !== undefined) {
    const c = compareKeys(key, range.upper);
    if (c > 0 || (c === 0 && range.upperOpen)) return false;
  }
  return true;
}

/** Resolves an index name to its spec; the primary key counts as an index named by its key path. */
export function indexSpec(store: StoreName, index: string): IndexSpec {
  const schema = parseSchema(store);
  const primaryName = Array.isArray(schema.keyPath)
    ? `[${(schema.keyPath as readonly string[]).join("+")}]`
    : (schema.keyPath as string);
  if (index === primaryName)
    return { name: index, keyPath: schema.keyPath, multiEntry: false };
  const found = schema.indexes.find((entry) => entry.name === index);
  if (!found) throw new Error(`${store} has no index ${index}`);
  return found;
}
