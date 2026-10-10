import { RESOURCE_KINDS } from "../../../src/data/model/types";

/**
 * Generators for `/sync` pages: realistic ones (the contract's shapes), dense ones (many changes, deep values) and a REFERENCE
 * validator that is deliberately independent of the scanner: it uses `JSON.parse` and plain structural checks. A seeded PRNG
 * keeps every generated document reproducible from its seed.
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

export const uuid = (n: number): string => {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};

export interface Projection {
  id: string;
  kind: string;
  parent_id: string | null;
  label: string;
  value: Record<string, unknown> | null;
  version: number;
  can_edit: boolean;
  archived: boolean;
  policy_version?: number;
}

const WORDS = [
  "water plants",
  "naïve ☃",
  "日本語",
  "line\nbreak",
  'quote " and \\ slash',
  "emoji 🌿",
  "tab\tsep",
  " ",
  "plain",
];

export function randomValue(
  rng: Rng,
  depth: number,
  budget: { n: number },
): unknown {
  budget.n -= 1;
  const leaf = depth <= 0 || budget.n <= 0 || rng.bool(0.4);
  if (leaf) {
    switch (rng.int(6)) {
      case 0:
        return rng.pick(WORDS);
      case 1:
        return rng.int(1_000_000) - 500_000;
      case 2:
        return rng.next() * 1000;
      case 3:
        return rng.bool();
      case 4:
        return null;
      default:
        return `s${rng.int(1000)}`;
    }
  }
  if (rng.bool()) {
    const n = rng.int(5);
    return Array.from({ length: n }, () => randomValue(rng, depth - 1, budget));
  }
  const out: Record<string, unknown> = {};
  const n = rng.int(5);
  for (let i = 0; i < n; i += 1)
    out[`k${rng.int(20)}`] = randomValue(rng, depth - 1, budget);
  return out;
}

export function projection(rng: Rng, n: number, valueDepth = 3): Projection {
  const out: Projection = {
    id: uuid(n),
    kind: rng.pick(RESOURCE_KINDS),
    parent_id: rng.bool(0.3) ? uuid(rng.int(1000) + 1) : null,
    label: rng.pick(WORDS),
    value: rng.bool(0.2)
      ? null
      : (randomValue(rng, valueDepth, { n: 30 }) as Record<
          string,
          unknown
        > | null),
    version: rng.int(50) + 1,
    can_edit: rng.bool(),
    archived: rng.bool(0.1),
  };
  if (typeof out.value !== "object" || Array.isArray(out.value))
    out.value = { v: out.value };
  if (rng.bool(0.5)) out.policy_version = rng.int(9) + 1;
  return out;
}

export type Change =
  | { kind: "upsert"; resource: Projection }
  | { kind: "remove"; id: string };

export interface PageSpec {
  phase?: "snapshot" | "delta";
  hasMore?: boolean;
  nextCursor?: string;
  batches: Array<{ revision: number; changes: Change[] }>;
}

export function randomPage(
  rng: Rng,
  seed: number,
  shape: { batches: number; changes: number; valueDepth?: number } = {
    batches: 3,
    changes: 6,
  },
): PageSpec {
  let n = seed * 100_000;
  return {
    phase: "delta",
    hasMore: rng.bool(),
    nextCursor: `cursor-${seed}-${rng.int(1e9).toString(36)}`,
    batches: Array.from({ length: shape.batches }, (_, b) => ({
      revision: b + 1 + rng.int(5),
      changes: Array.from({ length: shape.changes }, () => {
        n += 1;
        return rng.bool(0.8)
          ? {
              kind: "upsert" as const,
              resource: projection(rng, n, shape.valueDepth ?? 3),
            }
          : { kind: "remove" as const, id: uuid(n) };
      }),
    })),
  };
}

export function pageJson(
  spec: PageSpec,
  options: { spaces?: number; keyOrder?: "forward" | "reverse" } = {},
): string {
  const top: Record<string, unknown> = {
    phase: spec.phase ?? "delta",
    batches: spec.batches,
    next_cursor: spec.nextCursor ?? "c",
    has_more: spec.hasMore ?? false,
  };
  const keys = Object.keys(top);
  if (options.keyOrder === "reverse") keys.reverse();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = top[k];
  return JSON.stringify(ordered, null, options.spaces);
}

export const bytesOf = (text: string): Uint8Array =>
  new TextEncoder().encode(text);

/** The maximum nesting depth of a parsed value (a scalar is depth 0). */
export function depthOf(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  let max = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value))
    max = Math.max(max, depthOf(child));
  return max + 1;
}

export function nodeCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 1;
  let n = 1;
  for (const child of Array.isArray(value) ? value : Object.values(value))
    n += nodeCount(child);
  return n;
}

export interface Reference {
  ok: boolean;
  phase?: string;
  hasMore?: boolean;
  nextCursor?: string;
  revisions?: number[];
  counts?: number[];
  elements?: unknown[];
  nodes?: number[];
}

/** An independent reference: JSON.parse plus the structural rules the scanner is specified to enforce (documents here have no duplicate keys). */
export function reference(text: string, maxDepth = 24): Reference {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return { ok: false };
  const top = doc as Record<string, unknown>;
  const keys = Object.keys(top).sort().join(",");
  if (keys !== "batches,has_more,next_cursor,phase") return { ok: false };
  if (top.phase !== "snapshot" && top.phase !== "delta") return { ok: false };
  if (typeof top.has_more !== "boolean") return { ok: false };
  if (typeof top.next_cursor !== "string") return { ok: false };
  if ([...top.next_cursor].length > 512) return { ok: false };
  if (!Array.isArray(top.batches) || top.batches.length > 80)
    return { ok: false };
  if (depthOf(doc) > maxDepth) return { ok: false };
  const revisions: number[] = [];
  const counts: number[] = [];
  const elements: unknown[] = [];
  const nodes: number[] = [];
  for (const batch of top.batches) {
    if (typeof batch !== "object" || batch === null || Array.isArray(batch))
      return { ok: false };
    const b = batch as Record<string, unknown>;
    if (Object.keys(b).sort().join(",") !== "changes,revision")
      return { ok: false };
    if (
      typeof b.revision !== "number" ||
      !Number.isSafeInteger(b.revision) ||
      b.revision < 0
    )
      return { ok: false };
    if (!Array.isArray(b.changes) || b.changes.length > 800)
      return { ok: false };
    revisions.push(b.revision);
    counts.push(b.changes.length);
    for (const change of b.changes) {
      if (
        typeof change !== "object" ||
        change === null ||
        Array.isArray(change)
      )
        return { ok: false };
      elements.push(change);
      nodes.push(nodeCount(change));
    }
  }
  return {
    ok: true,
    phase: top.phase,
    hasMore: top.has_more,
    nextCursor: top.next_cursor,
    revisions,
    counts,
    elements,
    nodes,
  };
}
