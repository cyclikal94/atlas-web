import { DATA_CONFIG, type DataConfig } from "../model/config";
import { isAllocationError } from "../model/sizing";
import { codePointCount } from "./code-points";

/**
 * Pass 1 of bounded processing (plan 5.4.4, decision D-08): a single left-to-right scan of the response BYTES that validates the
 * document's JSON syntax and records only what pass 2 needs: the top-level `phase`, `next_cursor` and `has_more`, each batch's
 * `revision`, and the byte offsets of every element of `batches[*].changes[*]` (and a node count per element). It builds NO object
 * graph and NO full-document string: a 5.83 MiB dense page costs three integer arrays and a handful of small strings.
 *
 * It is strict. It accepts exactly the documents the contract allows and nothing the server never emits:
 *  - standard JSON syntax (no comments, no trailing commas, no leading zeros, no raw control characters in strings, valid escapes);
 *  - the top level is an object with EXACTLY the keys `phase`, `batches`, `next_cursor`, `has_more`, each once;
 *  - each batch is an object with EXACTLY `revision` (a plain non-negative integer literal) and `changes`, each once;
 *  - each change is a JSON object (its keys and values are pass 2's business);
 *  - nesting depth <= `maxDepth`, batches <= 80, changes per batch <= 800.
 * Structural bytes are ASCII and cannot occur inside a multi-byte UTF-8 sequence, so the scan needs no decoding; invalid UTF-8
 * inside a string is found where the string is decoded (pass 2, with a fatal decoder).
 */
export interface ScanBatch {
  revision: number;
  /** Index of the batch's first element in `elements` (pairs). */
  first: number;
  count: number;
}

export interface ScanOk {
  ok: true;
  phase: "snapshot" | "delta";
  hasMore: boolean;
  /** Decoded and length-checked, otherwise opaque: never parsed. */
  nextCursor: string;
  batches: ScanBatch[];
  /** `[start, end)` byte offsets of each change element, two entries per element. */
  elements: Uint32Array;
  /** Number of JSON values inside each element (the element itself included). */
  nodes: Uint32Array;
  totalChanges: number;
  stats: {
    containers: number;
    values: number;
    maxDepth: number;
    bytes: number;
  };
}

export interface ScanFail {
  ok: false;
  /** A fixed vocabulary: never text taken from the document. */
  stage: "syntax" | "structure" | "limit";
  reason: string;
  offset: number;
}

export type ScanResult = ScanOk | ScanFail;

class Fail extends Error {
  constructor(
    readonly stage: ScanFail["stage"],
    readonly reason: string,
    readonly offset: number,
  ) {
    super(reason);
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;

const isDigit = (c: number): boolean => c >= ZERO && c <= NINE;
const isHex = (c: number): boolean =>
  isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The most bytes ONE code point takes in a JSON string token (R41, revision 22): an astral character written as the two escapes of its
 * surrogates, `\ud83d\ude00`, is twelve (a BMP character escaped is six, a literal one at most four, a lone surrogate escape six). The
 * preliminary bound on a token assumed six, so a valid cursor of 257 escaped astral characters (514 code units, 257 code points, well inside
 * `maxLength: 512`) was refused as too long before the code points were ever counted.
 */
const MAX_BYTES_PER_CODE_POINT = 12;
/** The widest token (quotes included) a string of at most `codePoints` code points can be written as: a bound on WORK, never on the length. */
const tokenBytes = (codePoints: number): number =>
  codePoints * MAX_BYTES_PER_CODE_POINT + 2;
/** The longest decoded key and `phase` value looked at: a longer one is not a name of the contract and is refused by name, not by size. */
const MAX_KEY_CODE_POINTS = 64;
const MAX_PHASE_CODE_POINTS = 32;

export function scanSyncPage(
  bytes: Uint8Array,
  config: Pick<
    DataConfig,
    "maxDepth" | "maxScanElements" | "maxCursorLength" | "maxChangesPerBatch"
  > & { maxBatches?: number } = DATA_CONFIG,
): ScanResult {
  const maxBatches = config.maxBatches ?? 80;
  const length = bytes.length;
  let pos = 0;
  let containers = 0;
  let values = 0;
  let maxDepthSeen = 0;

  const fail = (stage: ScanFail["stage"], reason: string): never => {
    throw new Fail(stage, reason, pos);
  };
  const peek = (): number => (pos < length ? (bytes[pos] as number) : -1);
  const ws = (): void => {
    while (pos < length) {
      const c = bytes[pos] as number;
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) pos += 1;
      else break;
    }
  };
  const expect = (c: number, what: string): void => {
    if (peek() !== c) fail("syntax", `expected ${what}`);
    pos += 1;
  };

  /** Skips a string whose opening quote is at `pos`; returns [start, end) of the whole token including quotes. */
  const skipString = (): [number, number] => {
    const start = pos;
    if (peek() !== QUOTE) fail("syntax", "expected a string");
    pos += 1;
    while (pos < length) {
      const c = bytes[pos] as number;
      if (c === QUOTE) {
        pos += 1;
        return [start, pos];
      }
      if (c < 0x20) fail("syntax", "control character in a string");
      if (c === BACKSLASH) {
        pos += 1;
        const e = peek();
        if (
          e === 0x22 ||
          e === 0x5c ||
          e === 0x2f ||
          e === 0x62 ||
          e === 0x66 ||
          e === 0x6e ||
          e === 0x72 ||
          e === 0x74
        ) {
          pos += 1;
        } else if (e === 0x75) {
          pos += 1;
          for (let i = 0; i < 4; i += 1) {
            if (!isHex(peek())) fail("syntax", "bad unicode escape");
            pos += 1;
          }
        } else fail("syntax", "bad escape");
      } else pos += 1;
    }
    return fail("syntax", "unterminated string");
  };

  const skipNumber = (): void => {
    if (peek() === MINUS) pos += 1;
    if (peek() === ZERO) pos += 1;
    else if (isDigit(peek())) while (isDigit(peek())) pos += 1;
    else fail("syntax", "bad number");
    if (peek() === DOT) {
      pos += 1;
      if (!isDigit(peek())) fail("syntax", "bad number");
      while (isDigit(peek())) pos += 1;
    }
    const e = peek();
    if (e === 0x65 || e === 0x45) {
      pos += 1;
      if (peek() === PLUS || peek() === MINUS) pos += 1;
      if (!isDigit(peek())) fail("syntax", "bad number");
      while (isDigit(peek())) pos += 1;
    }
  };

  const literal = (word: string): void => {
    for (let i = 0; i < word.length; i += 1) {
      if (peek() !== word.charCodeAt(i)) fail("syntax", "bad literal");
      pos += 1;
    }
  };

  /** Skips any JSON value. `depth` is the nesting of the value being skipped (the top-level value is depth 1). */
  const skipValue = (depth: number): void => {
    ws();
    const c = peek();
    values += 1;
    if (c === LBRACE) {
      enter(depth);
      pos += 1;
      ws();
      if (peek() === RBRACE) {
        pos += 1;
        return;
      }
      for (;;) {
        ws();
        skipString();
        ws();
        expect(COLON, "':'");
        skipValue(depth + 1);
        ws();
        if (peek() === COMMA) {
          pos += 1;
          continue;
        }
        expect(RBRACE, "'}' or ','");
        return;
      }
    }
    if (c === LBRACKET) {
      enter(depth);
      pos += 1;
      ws();
      if (peek() === RBRACKET) {
        pos += 1;
        return;
      }
      for (;;) {
        skipValue(depth + 1);
        ws();
        if (peek() === COMMA) {
          pos += 1;
          continue;
        }
        expect(RBRACKET, "']' or ','");
        return;
      }
    }
    if (c === QUOTE) {
      skipString();
      return;
    }
    if (c === MINUS || isDigit(c)) {
      skipNumber();
      return;
    }
    if (c === 0x74) {
      literal("true");
      return;
    }
    if (c === 0x66) {
      literal("false");
      return;
    }
    if (c === 0x6e) {
      literal("null");
      return;
    }
    fail("syntax", "unexpected byte");
  };

  const enter = (depth: number): void => {
    containers += 1;
    if (depth > maxDepthSeen) maxDepthSeen = depth;
    if (depth > config.maxDepth) fail("limit", "nesting too deep");
  };

  /** The decoded text of a small string token (keys, `phase`, the cursor). */
  const stringText = (range: [number, number], maxBytes: number): string => {
    if (range[1] - range[0] > maxBytes) fail("limit", "string too long");
    let text: unknown;
    try {
      text = JSON.parse(decoder.decode(bytes.subarray(range[0], range[1])));
    } catch (error) {
      // Text that cannot be decoded or parsed is a fault of the page; an allocation failure while decoding a valid token is not (R44):
      // it leaves the scan as itself, for the caller's sizing policy.
      if (isAllocationError(error)) throw error;
      return fail("syntax", "invalid text");
    }
    if (typeof text !== "string") fail("syntax", "invalid text");
    return text as string;
  };

  /** A plain non-negative integer literal (no fraction, no exponent), as a safe integer. */
  const readInteger = (): number => {
    const start = pos;
    if (peek() === ZERO) pos += 1;
    else if (isDigit(peek())) while (isDigit(peek())) pos += 1;
    else fail("structure", "expected a non-negative integer");
    const next = peek();
    if (next === DOT || next === 0x65 || next === 0x45)
      fail("structure", "expected a plain integer");
    if (pos - start > 16) fail("structure", "integer too large");
    let n = 0;
    for (let i = start; i < pos; i += 1)
      n = n * 10 + ((bytes[i] as number) - ZERO);
    if (!Number.isSafeInteger(n)) fail("structure", "integer too large");
    return n;
  };

  try {
    // A byte order mark is not JSON.
    ws();
    expect(LBRACE, "'{'");
    containers += 1;
    values += 1;
    maxDepthSeen = 1;

    let phase: "snapshot" | "delta" | null = null;
    let hasMore: boolean | null = null;
    let nextCursor: string | null = null;
    let batches: ScanBatch[] | null = null;

    const maxElements = config.maxScanElements;
    let elements = new Uint32Array(Math.min(maxElements * 2, 1024));
    let nodeCounts = new Uint32Array(Math.min(maxElements, 512));
    let total = 0;
    const grow = (): void => {
      const nextEl = new Uint32Array(
        Math.min(maxElements * 2, elements.length * 2),
      );
      nextEl.set(elements);
      elements = nextEl;
      const nextNodes = new Uint32Array(
        Math.min(maxElements, nodeCounts.length * 2),
      );
      nextNodes.set(nodeCounts);
      nodeCounts = nextNodes;
    };

    const parseChanges = (): number => {
      // `changes` is an array (depth 4: document 1 > batches 2 > batch 3 > changes 4).
      ws();
      expect(LBRACKET, "an array of changes");
      enterContainer(4);
      let count = 0;
      ws();
      if (peek() === RBRACKET) {
        pos += 1;
        return 0;
      }
      for (;;) {
        ws();
        if (peek() !== LBRACE) fail("structure", "a change must be an object");
        if (total >= maxElements) fail("limit", "too many changes");
        if (count >= config.maxChangesPerBatch)
          fail("limit", "too many changes in a batch");
        if ((total + 1) * 2 > elements.length) grow();
        const start = pos;
        const before = values;
        skipValue(5);
        elements[total * 2] = start;
        elements[total * 2 + 1] = pos;
        nodeCounts[total] = values - before;
        total += 1;
        count += 1;
        ws();
        if (peek() === COMMA) {
          pos += 1;
          continue;
        }
        expect(RBRACKET, "']' or ','");
        return count;
      }
    };
    const enterContainer = (depth: number): void => {
      values += 1;
      enter(depth);
    };

    const parseBatch = (): { revision: number; count: number } => {
      ws();
      expect(LBRACE, "a batch object");
      enterContainer(3);
      let revision: number | null = null;
      let count: number | null = null;
      ws();
      if (peek() === RBRACE)
        fail("structure", "a batch needs revision and changes");
      for (;;) {
        ws();
        const key = stringText(skipString(), tokenBytes(MAX_KEY_CODE_POINTS));
        ws();
        expect(COLON, "':'");
        ws();
        if (key === "revision") {
          if (revision !== null) fail("structure", "duplicate revision");
          values += 1;
          revision = readInteger();
        } else if (key === "changes") {
          if (count !== null) fail("structure", "duplicate changes");
          count = parseChanges();
        } else fail("structure", "unknown batch key");
        ws();
        if (peek() === COMMA) {
          pos += 1;
          continue;
        }
        expect(RBRACE, "'}' or ','");
        break;
      }
      if (revision === null || count === null)
        fail("structure", "a batch needs revision and changes");
      return { revision: revision as number, count: count as number };
    };

    const parseBatches = (): ScanBatch[] => {
      ws();
      expect(LBRACKET, "an array of batches");
      enterContainer(2);
      const out: ScanBatch[] = [];
      ws();
      if (peek() === RBRACKET) {
        pos += 1;
        return out;
      }
      for (;;) {
        if (out.length >= maxBatches) fail("limit", "too many batches");
        const first = total;
        const { revision, count } = parseBatch();
        out.push({ revision, first, count });
        ws();
        if (peek() === COMMA) {
          pos += 1;
          continue;
        }
        expect(RBRACKET, "']' or ','");
        return out;
      }
    };

    ws();
    if (peek() === RBRACE) fail("structure", "the page is missing its fields");
    for (;;) {
      ws();
      const key = stringText(skipString(), tokenBytes(MAX_KEY_CODE_POINTS));
      ws();
      expect(COLON, "':'");
      ws();
      switch (key) {
        case "phase": {
          if (phase !== null) fail("structure", "duplicate phase");
          values += 1;
          const text = stringText(
            skipString(),
            tokenBytes(MAX_PHASE_CODE_POINTS),
          );
          if (text === "snapshot" || text === "delta") phase = text;
          else fail("structure", "unknown phase");
          break;
        }
        case "has_more": {
          if (hasMore !== null) fail("structure", "duplicate has_more");
          values += 1;
          if (peek() === 0x74) {
            literal("true");
            hasMore = true;
          } else if (peek() === 0x66) {
            literal("false");
            hasMore = false;
          } else fail("structure", "has_more must be a boolean");
          break;
        }
        case "next_cursor": {
          if (nextCursor !== null) fail("structure", "duplicate next_cursor");
          values += 1;
          // A cursor of up to 512 code points is at most 512 * 12 bytes of escapes, plus the quotes (R41): the token is bounded by what
          // every permitted representation can need, and the length proper is the code-point count of the decoded text, below.
          const text = stringText(
            skipString(),
            tokenBytes(config.maxCursorLength),
          );
          // Length is in Unicode code points (JSON Schema `maxLength`), not UTF-16 units; an unpaired surrogate counts as one (R38).
          if (codePointCount(text) > config.maxCursorLength)
            fail("limit", "cursor too long");
          nextCursor = text;
          break;
        }
        case "batches": {
          if (batches !== null) fail("structure", "duplicate batches");
          batches = parseBatches();
          break;
        }
        default:
          fail("structure", "unknown page key");
      }
      ws();
      if (peek() === COMMA) {
        pos += 1;
        continue;
      }
      expect(RBRACE, "'}' or ','");
      break;
    }
    ws();
    if (pos !== length) fail("syntax", "trailing bytes after the document");
    if (
      phase === null ||
      hasMore === null ||
      nextCursor === null ||
      batches === null
    )
      fail("structure", "the page is missing its fields");

    return {
      ok: true,
      phase: phase as "snapshot" | "delta",
      hasMore: hasMore as boolean,
      nextCursor: nextCursor as string,
      batches: batches as ScanBatch[],
      elements: elements.slice(0, total * 2),
      nodes: nodeCounts.slice(0, total),
      totalChanges: total,
      stats: { containers, values, maxDepth: maxDepthSeen, bytes: length },
    };
  } catch (error) {
    if (error instanceof Fail)
      return {
        ok: false,
        stage: error.stage,
        reason: error.reason,
        offset: error.offset,
      };
    // An allocation failure (the offset arrays, their growth, the trimmed copies, the decoding of a key or the cursor) is a resource
    // failure, not a malformed page: let the caller see it (the engine takes it to the sizing policy, R44).
    throw error;
  }
}
