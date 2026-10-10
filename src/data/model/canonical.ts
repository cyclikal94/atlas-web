/**
 * Canonical JSON and a SYNCHRONOUS SHA-256 (decision D-07). A consent digest must be computed INSIDE the transaction that
 * fences the drafts, and `crypto.subtle.digest` is asynchronous: awaiting it would end an IndexedDB transaction. So the
 * digest is a small pure module over values the rows already carry (`command_digest`, `content_digest`).
 */

/**
 * Sorted keys, no whitespace; throws on a value JSON cannot carry exactly (undefined, functions, non-finite numbers) and on a HOLE in an
 * array (R40, revision 22). `Array.prototype.map` skips a hole, so `new Array(1)` was `[]` here (and so had the digest of the empty list)
 * while `JSON.stringify` says `[null]`, and two holes made `[,]`, which is not JSON. A hole is the absence of a member, as `undefined` is
 * the absence of a value, and neither has a form: the public boundary refuses both (`snapshot.ts`) and this function does not answer for them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("a non-finite number has no canonical form");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const members: string[] = [];
        for (let i = 0; i < value.length; i += 1) {
          if (!(i in value))
            throw new TypeError("a hole in an array has no canonical form");
          members.push(canonicalJson(value[i]));
        }
        return `[${members.join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>).sort(
        ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
      );
      return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
    }
    default:
      throw new TypeError(`a ${typeof value} has no canonical form`);
  }
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of a byte string, as lower-case hex. */
export function sha256Bytes(message: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const length = message.length;
  // Padding: 0x80, zeros, then the 64-bit big-endian bit length.
  const total = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(message);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000), false);
  view.setUint32(total - 4, (length << 3) >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1)
      w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i += 1)
    hex += ((h[i] as number) >>> 0).toString(16).padStart(8, "0");
  return hex;
}

const encoder = new TextEncoder();
export const sha256Hex = (text: string): string =>
  sha256Bytes(encoder.encode(text));

/** The digest a draft stores: SHA-256 of the canonical JSON of its command. */
export const digestOf = (value: unknown): string =>
  sha256Hex(canonicalJson(value));
