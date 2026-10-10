/**
 * A private, validated copy of a value a caller owns (R39 and R40, revision 22).
 *
 * THE RULE THIS STANDS FOR: what a save is admitted at, what its digest says and what is stored are ONE value. A plan used to digest and
 * measure the object a request's `build` returned and then hand that same object on, by reference, to a write that the adapter issues one
 * request at a time: IndexedDB clones a value when its `put` is CALLED, and the header's `put` is awaited before the body's, so a caller
 * that edits its graph in that interval (an event handler, a form that is still being typed into) changes what the body stores after the
 * digest and the quota admission were taken. Nothing in the build contract gives the plan exclusive ownership of the graph it returns, and a
 * shallow copy shares every nested value, so the plan takes ONE deep copy, once, at the instant it reads the result, and everything after
 * it (digest, size, header, body) is derived from that copy and from nothing the caller can still reach.
 *
 * WHAT THE COPY IS. Exactly what a structured clone would retain, made now and as plain data: `null`, `undefined`, booleans, finite
 * numbers, strings, arrays and plain objects, each own enumerable string-keyed property (an array's named properties included: they are
 * stored, and the quota measure counts them), read ONCE as DATA from its descriptor so that no accessor of the caller's runs and none can
 * answer twice. Refused, as a `TypeError` (the plans report it as `not_json`): a function, a symbol, a bigint, a non-finite number, a `Map`,
 * a `Date`, a typed array or any other class instance, an accessor, a cycle, a value nested deeper than {@link MAX_DEPTH}, a proxy that
 * throws, and a SPARSE ARRAY.
 *
 * A HOLE IS REFUSED, NOT NORMALISED (R40). `JSON.stringify` writes a hole as `null`, `Array.prototype.map` skips it, and a structured clone
 * keeps it as a hole, so three readings of one value disagreed, and the canonical form (which `map`ped) gave `new Array(1)` the digest of
 * `[]`. Normalising a hole to `null` would have to build an array as long as the hole list (`new Array(1e9)`), where a refusal costs one
 * property read; and an `undefined` member is already refused by the canonical form, so a hole, which is the absence of a member, is
 * refused with it. The policy is the same for every graph a build returns (the command, the display patch and the defaults context).
 */

/** The deepest nesting followed (the size measure in `outbox.ts` stops at the same depth). */
export const MAX_DEPTH = 256;

/** An array index as a property key: `"0"`, `"1"`, ... below 2^32 - 1, in canonical form (a clone treats nothing else as an element). */
export const isArrayIndex = (key: string): boolean =>
  /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff;

/** A refusal: the value is not plain JSON data. A `TypeError`, as the plans' `not_json` classification expects. */
export class NotPlainData extends TypeError {
  constructor(what: string) {
    super(`not plain JSON data: ${what}`);
    this.name = "NotPlainData";
  }
}

/** The own data property `key` of `item`: an accessor is not data, and an absent one is the caller's to explain. */
function dataOf(item: object, key: string, absent: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(item, key);
  if (descriptor === undefined) throw new NotPlainData(absent);
  if (!("value" in descriptor)) throw new NotPlainData("an accessor");
  return descriptor.value;
}

/**
 * A deep copy of `value` as plain data, or a {@link NotPlainData}. Reads each property of the caller's graph once and never calls caller code
 * other than a proxy's own traps; the result shares nothing mutable with the original.
 */
export function snapshotPlain(value: unknown): unknown {
  const path = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (item === null || item === undefined) return item;
    switch (typeof item) {
      case "boolean":
      case "string":
        return item;
      case "number":
        if (!Number.isFinite(item))
          throw new NotPlainData("a non-finite number");
        return item;
      case "object":
        break;
      default:
        throw new NotPlainData(`a ${typeof item}`);
    }
    if (depth >= MAX_DEPTH) throw new NotPlainData("nested too deeply");
    if (path.has(item)) throw new NotPlainData("a cycle");
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    // A plain object's prototype is a root prototype (`Object.prototype` of any realm); a `Map`, `Date` or class instance has another.
    if (!array && proto !== null && Object.getPrototypeOf(proto) !== null)
      throw new NotPlainData("an object that is not plain");
    path.add(item);
    const keys = Object.keys(item);
    let out: unknown;
    if (array) {
      const length = (item as unknown[]).length;
      const members: unknown[] = [];
      // Every index is read, in order, as data: the first one that is absent is a hole (R40), however long the list claims to be.
      for (let i = 0; i < length; i += 1)
        members.push(
          copy(dataOf(item, String(i), "a hole in an array"), depth + 1),
        );
      // What a clone keeps beyond the members: the named properties (own, enumerable, string-keyed, not an index).
      for (const key of keys)
        if (!isArrayIndex(key))
          Object.defineProperty(members, key, {
            value: copy(
              dataOf(item, key, "a property that vanished"),
              depth + 1,
            ),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      out = members;
    } else
      out = Object.fromEntries(
        keys.map((key) => [
          key,
          copy(dataOf(item, key, "a property that vanished"), depth + 1),
        ]),
      );
    path.delete(item);
    return out;
  };
  try {
    return copy(value, 0);
  } catch (error) {
    // A proxy trap that throws, a revoked proxy: the value cannot be read as data, which is the same answer.
    if (error instanceof NotPlainData) throw error;
    throw new NotPlainData("a value that could not be read");
  }
}
