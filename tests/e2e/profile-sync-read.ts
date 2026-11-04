import type { Page } from "@playwright/test";

/**
 * One `/sync` read through a booted `/__session` page's stamped wrapper (the cursor belongs to the page's session), as the engine reads it:
 * the response body's exact BYTES (WEB-09c revision 5; design assessment DA-E3, A2). `Response.text()` decodes before anything can be
 * hashed or kept: it drops a byte order mark and replaces invalid UTF-8, so a capture read that way was not the body the engine receives.
 * The page reads `arrayBuffer()` and carries it to the test as base64 (lossless); `text` is a lossy view for messages only, never evidence.
 *
 * Shared by the W2 capture writer (`tests/integration/integration.profile-sync.spec.ts`) and its byte-identity check against a scripted
 * stub (`tests/e2e/fixture.profile-sync-read.spec.ts`).
 */
export interface SyncRead {
  status: number;
  bytes: Buffer;
  /** The bytes decoded for a message (lossy); never hashed, kept or certified. */
  text: string;
  error: string | null;
}

type Booted = {
  session: {
    api: {
      fetchFor(
        kind: "ordinary",
        account: string,
        epoch: number,
      ): (request: Request) => Promise<Response>;
    };
  };
};

export async function readSyncBytes(
  page: Page,
  account: string,
  epoch: number,
  cursor: string | null,
  limit: number,
): Promise<SyncRead> {
  const read = await page.evaluate(
    async ({ a, e, c, l }) => {
      const fixture = (
        window as unknown as {
          __atlasFixture?: { session?: { ready: Promise<Booted | null> } };
        }
      ).__atlasFixture;
      const booted = await fixture?.session?.ready;
      if (!booted)
        return { status: 0, base64: "", error: "no booted session harness" };
      const fetchPage = booted.session.api.fetchFor("ordinary", a, e);
      const url = new URL("/api/experimental/v1/sync", location.origin);
      if (c !== null) url.searchParams.set("cursor", c);
      url.searchParams.set("limit", String(l));
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const response = await fetchPage(new Request(url, { method: "GET" }));
          const body = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let at = 0; at < body.length; at += 0x8000)
            binary += String.fromCharCode(...body.subarray(at, at + 0x8000));
          return {
            status: response.status,
            base64: btoa(binary),
            error: null as string | null,
          };
        } catch (error) {
          if (!String(error).includes("not_sent"))
            return {
              status: 0,
              base64: "",
              error: String(error).slice(0, 200),
            };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      return { status: 0, base64: "", error: "not_sent for six seconds" };
    },
    { a: account, e: epoch, c: cursor, l: limit },
  );
  const bytes = Buffer.from(read.base64, "base64");
  return {
    status: read.status,
    bytes,
    text: bytes.toString("utf8"),
    error: read.error,
  };
}
