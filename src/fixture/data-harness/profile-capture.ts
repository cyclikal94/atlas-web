/**
 * FIXTURE ONLY (never packaged; `check-no-fixture`). The device page's route for W2 (review finding R3): W2 is not generated. It is the
 * server-maximal dense batch the released backend produced, captured from the real `/sync` by the integration stage and carried in the
 * hand-over (`handoff/fixtures/W2-captured.<engine>.limit-1.json`, hashes in `handoff/fixtures/W2-hashes.json`).
 *
 * The operator copies one capture onto the device and picks it once with the page's file input, in the tab that then runs the protocol: the
 * page hashes it and keeps it in that tab's `sessionStorage`, which survives the protocol's reloads (Cache Storage entries and the origin
 * private file system do not survive them in an ephemeral WebKit session; raw IndexedDB is rule R13's). The page reads it only on a W2
 * run, as a generated workload is held only on its own run. Nothing goes over the network (rule R1: a same-origin request would carry the
 * session's credentials, so only the stamped wrapper may make one). The run URL names the capture's SHA-256 from `W2-hashes.json`:
 *
 *   /profile-harness?protocol=1&w2sha256=<hex>
 *
 * Every cold run reads the stored bytes afresh, hashes what it read and runs them only as they are; the run records the hash, whether it
 * equals the one named, and the file's name. The validator then checks the hash against the hand-over's `W2-hashes.json` (`--w2-hashes`),
 * so a run of any other bytes is refused.
 */
export const W2 = "W2";
const CAPTURE_KEY = "atlas-profile-w2";
const NAME_KEY = "atlas-profile-w2-name";

/** The capture a run is to use: the SHA-256 the URL names. */
export interface CaptureSource {
  sha256: string;
}

export interface LoadedCapture {
  ok: boolean;
  bytes: Uint8Array;
  sha256: string;
  verified: boolean;
  name: string;
  detail: string;
}

/** Where the picked capture is kept between cold runs. */
export interface CaptureStore {
  put(bytes: Uint8Array, name: string): Promise<void>;
  get(): Promise<{ bytes: Uint8Array; name: string } | null>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The capture the URL names (`w2sha256`), or null when there is none or it is not a SHA-256. */
export function captureFrom(params: URLSearchParams): CaptureSource | null {
  const sha256 = params.get("w2sha256")?.toLowerCase() ?? "";
  return HEX64.test(sha256) ? { sha256 } : null;
}

/** The query that carries the capture on to another link of the page (a single run, the protocol). */
export const captureQuery = (source: CaptureSource | null): string =>
  source ? `&w2sha256=${source.sha256}` : "";

/**
 * The protocol's runs, in order: every generated workload, `runs(name)` cold runs each, and W2 (after W1) only when a capture is named.
 * Without one the protocol has no W2 and its results are incomplete: the validator says so.
 */
export function protocolPlan(
  names: readonly string[],
  runs: (name: string) => number,
  withW2: boolean,
): Array<{ name: string; run: number }> {
  const order = withW2
    ? names.flatMap((name) => (name === "W1" ? [name, W2] : [name]))
    : [...names];
  return order.flatMap((name) =>
    Array.from({ length: runs(name) }, (_, i) => ({ name, run: i + 1 })),
  );
}

/** SHA-256 of bytes, lower-case hex (a secure context's Web Crypto). */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * This tab's `sessionStorage`: one capture, replaced by each pick. The bytes are kept as their UTF-8 text (a capture that is not valid UTF-8
 * is refused when it is picked), so reading them back gives the same bytes; the run hashes what it read, so any difference would show.
 */
export function sessionStore(storage: Storage = sessionStorage): CaptureStore {
  return {
    async put(bytes, name) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      storage.removeItem(CAPTURE_KEY);
      storage.setItem(CAPTURE_KEY, text);
      storage.setItem(NAME_KEY, name);
    },
    async get() {
      const text = storage.getItem(CAPTURE_KEY);
      if (text === null) return null;
      return {
        bytes: new TextEncoder().encode(text),
        name: storage.getItem(NAME_KEY) ?? "",
      };
    },
  };
}

/** Keeps the picked file and returns what was kept: its name, size and SHA-256. */
export async function storeCapture(
  file: Blob,
  name: string,
  store: CaptureStore = sessionStore(),
): Promise<{ name: string; bytes: number; sha256: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await store.put(bytes, name);
  return { name, bytes: bytes.length, sha256: await sha256Bytes(bytes) };
}

/** Reads the kept capture afresh and hashes what was read. No capture kept is an unsuccessful load with its reason, never a substitute. */
export async function loadCapture(
  source: CaptureSource,
  store: CaptureStore = sessionStore(),
): Promise<LoadedCapture> {
  const failed = (detail: string): LoadedCapture => ({
    ok: false,
    bytes: new Uint8Array(),
    sha256: "",
    verified: false,
    name: "",
    detail,
  });
  try {
    const kept = await store.get();
    if (!kept)
      return failed(
        "no W2 capture is kept on this origin: choose the capture file first",
      );
    const sha256 = await sha256Bytes(kept.bytes);
    const verified = sha256 === source.sha256;
    return {
      ok: true,
      bytes: kept.bytes,
      sha256,
      verified,
      name: kept.name,
      detail: verified
        ? `${kept.bytes.length} bytes of ${kept.name}`
        : `${kept.bytes.length} bytes of ${kept.name} do NOT have the SHA-256 the URL names`,
    };
  } catch (error) {
    return failed(
      `the kept capture could not be read: ${String(error).slice(0, 160)}`,
    );
  }
}
