import { describe, expect, it } from "vitest";
import {
  type CaptureStore,
  captureFrom,
  captureQuery,
  loadCapture,
  protocolPlan,
  sessionStore,
  sha256Bytes,
  storeCapture,
} from "../../src/fixture/data-harness/profile-capture";

/** The device page's W2 route (review R3): the capture picked once and kept, read back and hashed on every run, and the protocol with it. */
const BYTES = new TextEncoder().encode('{"phase":"delta","batches":[]}');
function memoryStore(): CaptureStore & {
  kept: { bytes: Uint8Array; name: string } | null;
} {
  return {
    kept: null,
    async put(bytes, name) {
      this.kept = { bytes: bytes.slice(), name };
    },
    async get() {
      return this.kept;
    },
  };
}

describe("profile capture (W2 on the device page)", () => {
  it("reads the capture's SHA-256 from the URL, and refuses one that is not a SHA-256", () => {
    const sha = "ab".repeat(32);
    expect(captureFrom(new URLSearchParams(`w2sha256=${sha}`))).toEqual({
      sha256: sha,
    });
    expect(captureFrom(new URLSearchParams("w2sha256=abc"))).toBeNull();
    expect(captureFrom(new URLSearchParams(""))).toBeNull();
    expect(captureQuery({ sha256: sha })).toBe(`&w2sha256=${sha}`);
    expect(captureQuery(null)).toBe("");
  });

  it("control: the picked file is kept, read back on a run, hashed and verified against the hash the URL names", async () => {
    const store = memoryStore();
    const kept = await storeCapture(
      new Blob([BYTES]),
      "W2-captured.x.json",
      store,
    );
    const sha = await sha256Bytes(BYTES);
    expect(kept).toEqual({
      name: "W2-captured.x.json",
      bytes: BYTES.length,
      sha256: sha,
    });
    const loaded = await loadCapture({ sha256: sha }, store);
    expect(loaded).toMatchObject({
      ok: true,
      sha256: sha,
      verified: true,
      name: "W2-captured.x.json",
    });
    expect([...loaded.bytes]).toEqual([...BYTES]);
  });

  it("case: other bytes are hashed as they are and are NOT verified", async () => {
    const store = memoryStore();
    await storeCapture(new Blob([BYTES]), "other.json", store);
    const loaded = await loadCapture({ sha256: "0".repeat(64) }, store);
    expect(loaded.ok).toBe(true);
    expect(loaded.verified).toBe(false);
    expect(loaded.sha256).toBe(await sha256Bytes(BYTES));
    expect(loaded.detail).toContain("do NOT have the SHA-256");
  });

  it("case: no kept capture, or one that cannot be read, is an unsuccessful load with its reason, never a substitute", async () => {
    const none = await loadCapture({ sha256: "0".repeat(64) }, memoryStore());
    expect(none).toMatchObject({ ok: false, verified: false, sha256: "" });
    expect(none.bytes.length).toBe(0);
    expect(none.detail).toContain("choose the capture file first");
    const broken = await loadCapture(
      { sha256: "0".repeat(64) },
      {
        put: async () => undefined,
        get: async () => {
          throw new TypeError("storage unavailable");
        },
      },
    );
    expect(broken).toMatchObject({ ok: false, verified: false });
    expect(broken.detail).toContain("storage unavailable");
  });

  it("the tab's sessionStorage gives back exactly the bytes it kept, and refuses bytes that are not UTF-8", async () => {
    sessionStorage.clear();
    const store = sessionStore();
    const text = new TextEncoder().encode('{"label":"caf\u00e9 \u2713"}');
    await storeCapture(new Blob([text]), "W2.json", store);
    const back = await store.get();
    expect(back?.name).toBe("W2.json");
    expect([...(back?.bytes ?? [])]).toEqual([...text]);
    await expect(
      storeCapture(new Blob([new Uint8Array([0xff, 0xfe])]), "bad.json", store),
    ).rejects.toThrow();
    // Refused BEFORE anything is written: the capture kept earlier is still the one kept.
    const still = await store.get();
    expect(still?.name).toBe("W2.json");
    expect([...(still?.bytes ?? [])]).toEqual([...text]);
    sessionStorage.clear();
    expect(await sessionStore().get()).toBeNull();
  });

  it("case: a write the storage refuses leaves the previous capture exactly as it was (one record: name, bytes and hash together)", async () => {
    sessionStorage.clear();
    const kept = new TextEncoder().encode('{"kept":true}');
    await storeCapture(new Blob([kept]), "kept.json", sessionStore());
    let refuse = false;
    const quota: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: (k) => sessionStorage.getItem(k),
      removeItem: (k) => sessionStorage.removeItem(k),
      setItem: (k, v) => {
        if (refuse) throw new DOMException("quota", "QuotaExceededError");
        sessionStorage.setItem(k, v);
      },
    };
    refuse = true;
    await expect(
      storeCapture(
        new Blob([new TextEncoder().encode('{"new":true}')]),
        "new.json",
        sessionStore(quota),
      ),
    ).rejects.toThrow(/quota/);
    const back = await sessionStore().get();
    expect(back?.name).toBe("kept.json");
    expect([...(back?.bytes ?? [])]).toEqual([...kept]);
    sessionStorage.clear();
  });

  it("case: nothing is acknowledged before the kept record reads back as the picked bytes", async () => {
    const lying: CaptureStore = {
      put: async () => undefined,
      get: async () => ({ bytes: new Uint8Array([1, 2, 3]), name: "x.json" }),
    };
    await expect(
      storeCapture(new Blob([BYTES]), "x.json", lying),
    ).rejects.toThrow(/not the one picked/);
  });

  it("case: a malformed kept record is an unsuccessful load, never a capture", async () => {
    sessionStorage.clear();
    sessionStorage.setItem("atlas-profile-w2-capture", '{"name":1}');
    const loaded = await loadCapture({ sha256: "0".repeat(64) });
    expect(loaded).toMatchObject({ ok: false, verified: false });
    expect(loaded.detail).toContain("malformed");
    sessionStorage.clear();
  });

  it("the protocol runs W2 five times after W1 only when a capture is named", () => {
    const names = ["W1", "W3", "W7-x"];
    const runs = (name: string) => (name === "W7-x" ? 1 : 5);
    const withW2 = protocolPlan(names, runs, true);
    expect(withW2.filter((r) => r.name === "W2").map((r) => r.run)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(withW2.map((r) => r.name).indexOf("W2")).toBe(5);
    expect(withW2).toHaveLength(16);
    const without = protocolPlan(names, runs, false);
    expect(without.some((r) => r.name === "W2")).toBe(false);
    expect(without).toHaveLength(11);
  });
});
