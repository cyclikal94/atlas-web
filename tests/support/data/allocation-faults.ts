import { DATA_CONFIG } from "../../../src/data/model/config";

/**
 * NAMED fault injections for the allocation sites of a page's processing (R44, revision 24). A real engine cannot be made to run out of
 * memory on request, so each failure here is a deliberate throw of the exception the engine's own policy reads as one, installed at ONE
 * named site of the production scanner and decoder and nowhere else. They test the handling of that exception, not a physical
 * memory-exhaustion measurement; the reports say so.
 *
 * `installAllocationFault` is SELF-CONTAINED (it names only globals and its argument) so that a native spec can hand the very same function
 * to `page.evaluate` and install the fault in the LIVE page, where the production bundle's own scanner and decoder run (the reviewer's
 * probes patch the same globals). It records what it did on `globalThis.__allocationFault` (hits and the stack of each), so every case
 * can assert its PREMISE (the fault fired, at the site) before it asserts a consequence.
 *
 * The sites, by what the production code does there:
 *  - scan.ts `scanSyncPage`: `offsets.initial`, `nodes.initial` (the two typed arrays), `offsets.growth`, `nodes.growth` (they double
 *    when a page has more than 512 changes), `offsets.copy`, `nodes.copy` (the final trimmed copies);
 *  - scan.ts `stringText`, the small tokens: `key.decode`, `key.parse` (the page's `next_cursor` key), `cursor.decode`, `cursor.parse`;
 *  - validate.ts `decodeChange`, one element at a time inside the commit: `change.decode`, `change.parse`.
 * A typed array is told from the others by its length (the scan's constants, from `DATA_CONFIG`), and `nodes.growth` by being the second
 * array of its length (the first is the initial offsets), so it is meaningful for one scan only: use `times: 1`.
 */
export type FaultKind = "allocation" | "syntax" | "utf8" | "defect";
export type ScanSite =
  | "offsets.initial"
  | "nodes.initial"
  | "offsets.growth"
  | "nodes.growth"
  | "offsets.copy"
  | "nodes.copy";
export type TextSite =
  | "key.decode"
  | "key.parse"
  | "cursor.decode"
  | "cursor.parse"
  | "change.decode"
  | "change.parse";
export type AllocationSite = ScanSite | TextSite;

export const SCAN_SITES: readonly ScanSite[] = [
  "offsets.initial",
  "nodes.initial",
  "offsets.growth",
  "nodes.growth",
  "offsets.copy",
  "nodes.copy",
];
export const TEXT_SITES: readonly TextSite[] = [
  "key.decode",
  "key.parse",
  "cursor.decode",
  "cursor.parse",
  "change.decode",
  "change.parse",
];

/** The lengths of the scan's typed arrays (scan.ts: the initial arrays and what `grow` makes of them). */
export interface ScanLengths {
  offsets: number;
  nodes: number;
  offsetsGrown: number;
  nodesGrown: number;
}
export const scanLengths = (config = DATA_CONFIG): ScanLengths => {
  const offsets = Math.min(config.maxScanElements * 2, 1024);
  const nodes = Math.min(config.maxScanElements, 512);
  return {
    offsets,
    nodes,
    offsetsGrown: Math.min(config.maxScanElements * 2, offsets * 2),
    nodesGrown: Math.min(config.maxScanElements, nodes * 2),
  };
};

export interface FaultSpec {
  site: AllocationSite;
  /**
   * What is thrown: the allocation failure the policy reads as the device's (default), a CONTROL that is a fault of the data (`syntax`,
   * `utf8`), or a CONTROL that is neither (`defect`: a plain `Error`, which only the loop's own stop may answer).
   */
  kind?: FaultKind;
  /** How many matching calls fail (default 1); a persistent fault passes a large number. */
  times?: number;
  /** How many matching calls pass first (default 0): an element in the middle of a page. */
  skip?: number;
  /** The page's `next_cursor`, for the cursor sites. */
  cursor?: string;
  /** For the `*.copy` sites: whether the page is large enough for the arrays to have grown (more than 512 changes). */
  grown?: boolean;
  lengths: ScanLengths;
}

export interface FaultHandle {
  hits: number;
  stacks: string[];
  restore: () => void;
}

/** Installs ONE fault in the global scope it runs in (the test process, or the page when handed to `page.evaluate`). */
export function installAllocationFault(spec: FaultSpec): void {
  // biome-ignore lint/suspicious/noExplicitAny: the page's globals, patched by name
  const g = globalThis as any;
  g.__allocationFault?.restore();
  const kind = spec.kind ?? "allocation";
  const times = spec.times ?? 1;
  const skip = spec.skip ?? 0;
  const site = spec.site;
  const lengths = spec.lengths;
  const handle: FaultHandle = { hits: 0, stacks: [], restore: () => undefined };
  const restores: Array<() => void> = [];
  let matched = 0;
  const make = (): Error =>
    kind === "allocation"
      ? new RangeError("named allocation injection")
      : kind === "syntax"
        ? new SyntaxError("named invalid-data control")
        : kind === "utf8"
          ? new TypeError("named invalid UTF-8 control")
          : new Error("named defect of a step");
  /** True when THIS matching call is to fail. */
  const fire = (): boolean => {
    matched += 1;
    if (matched <= skip || handle.hits >= times) return false;
    handle.hits += 1;
    handle.stacks.push(new Error().stack ?? "");
    return true;
  };

  const grown = spec.grown === true;
  const construct: Record<string, { length: number; nth: number }> = {
    "offsets.initial": { length: lengths.offsets, nth: 1 },
    "nodes.initial": { length: lengths.nodes, nth: 1 },
    "offsets.growth": { length: lengths.offsetsGrown, nth: 1 },
    // The first array of this length is the initial offsets.
    "nodes.growth": { length: lengths.nodesGrown, nth: 2 },
  };
  const slice: Record<string, number> = {
    "offsets.copy": grown ? lengths.offsetsGrown : lengths.offsets,
    "nodes.copy": grown ? lengths.nodesGrown : lengths.nodes,
  };
  const text: Record<
    string,
    { op: "decode" | "parse"; match: (t: string) => boolean }
  > = {
    "key.decode": { op: "decode", match: (t) => t === '"next_cursor"' },
    "key.parse": { op: "parse", match: (t) => t === '"next_cursor"' },
    "cursor.decode": {
      op: "decode",
      match: (t) => t === JSON.stringify(spec.cursor ?? "after-page"),
    },
    "cursor.parse": {
      op: "parse",
      match: (t) => t === JSON.stringify(spec.cursor ?? "after-page"),
    },
    "change.decode": { op: "decode", match: (t) => t.startsWith('{"kind":') },
    "change.parse": { op: "parse", match: (t) => t.startsWith('{"kind":') },
  };

  const wantConstruct = construct[site];
  const wantSlice = slice[site];
  const wantText = text[site];
  if (wantConstruct !== undefined) {
    const Native = g.Uint32Array;
    const seen = new Map<number, number>();
    g.Uint32Array = new Proxy(Native, {
      construct(target: unknown, args: unknown[], newTarget: unknown) {
        if (typeof args[0] === "number") {
          const nth = (seen.get(args[0]) ?? 0) + 1;
          seen.set(args[0], nth);
          if (
            args[0] === wantConstruct.length &&
            nth >= wantConstruct.nth &&
            fire()
          )
            throw make();
        }
        return Reflect.construct(target as never, args, newTarget as never);
      },
    });
    restores.push(() => {
      g.Uint32Array = Native;
    });
  } else if (wantSlice !== undefined) {
    const proto = g.Uint32Array.prototype;
    const own = Object.getOwnPropertyDescriptor(proto, "slice");
    const original = proto.slice;
    Object.defineProperty(proto, "slice", {
      configurable: true,
      writable: true,
      value: function (this: { length: number }, ...args: unknown[]) {
        if (this.length === wantSlice && fire()) throw make();
        return original.apply(this, args);
      },
    });
    restores.push(() => {
      if (own !== undefined) Object.defineProperty(proto, "slice", own);
      else delete proto.slice;
    });
  } else if (wantText !== undefined && wantText.op === "decode") {
    const proto = g.TextDecoder.prototype;
    const original = proto.decode;
    proto.decode = function (this: unknown, ...args: unknown[]) {
      const decoded = original.apply(this, args);
      if (wantText.match(decoded) && fire()) throw make();
      return decoded;
    };
    restores.push(() => {
      proto.decode = original;
    });
  } else if (wantText !== undefined) {
    const original = g.JSON.parse;
    g.JSON.parse = function (
      this: unknown,
      source: unknown,
      ...rest: unknown[]
    ) {
      if (typeof source === "string" && wantText.match(source) && fire())
        throw make();
      return original.call(this, source, ...rest);
    };
    restores.push(() => {
      g.JSON.parse = original;
    });
  } else {
    throw new Error(`no such allocation site: ${site}`);
  }
  handle.restore = () => {
    for (const restore of restores.splice(0).reverse()) restore();
    if (g.__allocationFault === handle) g.__allocationFault = undefined;
  };
  g.__allocationFault = handle;
}

/** What the page's fault recorded so far, from inside the page (for `page.evaluate`). */
export function readAllocationFault(): {
  hits: number;
  stacks: string[];
} | null {
  const handle = (globalThis as { __allocationFault?: FaultHandle })
    .__allocationFault;
  return handle === undefined
    ? null
    : { hits: handle.hits, stacks: handle.stacks };
}

/** Removes the page's fault, whatever it was (for `page.evaluate`). */
export function removeAllocationFault(): void {
  (
    globalThis as { __allocationFault?: FaultHandle }
  ).__allocationFault?.restore();
}

// ---- in-process use (vitest) --------------------------------------------------------------------------------------------------------

let active: FaultHandle | null = null;

/** Installs a fault in THIS process and returns its record; `restoreFaults()` (an `afterEach`) puts every global back. */
export function injectFault(
  site: AllocationSite,
  options: Omit<FaultSpec, "site" | "lengths"> = {},
): FaultHandle {
  installAllocationFault({ ...options, site, lengths: scanLengths() });
  const handle = (globalThis as { __allocationFault?: FaultHandle })
    .__allocationFault as FaultHandle;
  active = handle;
  return handle;
}

export function restoreFaults(): void {
  active?.restore();
  active = null;
}
