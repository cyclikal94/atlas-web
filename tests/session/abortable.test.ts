import { afterEach, describe, expect, test, vi } from "vitest";
import { abortable, raceAbort } from "../../src/lib/api-client/abortable";
import { createIssueTransport } from "../../src/lib/api-client/boundary";
import { createUnstampedApi } from "../../src/lib/api-client/unstamped";

/**
 * The page must move on the moment it aborts a request, whatever the engine does with the pending `fetch` (Playwright's WebKit
 * was seen to leave one pending after `abort()`, which kept `atlas-auth` held and an attempt in `activating`). Every `fetch` in
 * these tests IGNORES its signal, which is the engine behaviour being defended against.
 */
afterEach(() => vi.unstubAllGlobals());

const never = () => new Promise<Response>(() => undefined);
const request = (signal: AbortSignal) =>
  new Request("http://localhost/api/experimental/v1/x", {
    method: "POST",
    body: "{}",
    signal,
  });
const settled = async (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "resolved",
      (error: Error) => `rejected:${error.name}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);

describe("raceAbort and abortable", () => {
  test("a send that ignores its signal still rejects with AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const result = abortable(never)(request(controller.signal));
    expect(await settled(result)).toBe("pending");
    controller.abort();
    expect(await settled(result)).toBe("rejected:AbortError");
  });

  test("the underlying send is called synchronously, once (the boundary issues in one step)", () => {
    const send = vi.fn(never);
    const controller = new AbortController();
    void abortable(send)(request(controller.signal)).catch(() => undefined);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("an answer that arrives first resolves, and a later abort changes nothing", async () => {
    const controller = new AbortController();
    const response = new Response("{}");
    const result = abortable(async () => response)(request(controller.signal));
    expect(await result).toBe(response);
    controller.abort();
    expect(await result).toBe(response);
  });

  test("a failure of the send is passed through untouched", async () => {
    const controller = new AbortController();
    const failure = new TypeError("network");
    await expect(
      abortable(() => Promise.reject(failure))(request(controller.signal)),
    ).rejects.toBe(failure);
  });

  test("a signal that is already aborted rejects at once", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await settled(abortable(never)(request(controller.signal)))).toBe(
      "rejected:AbortError",
    );
  });

  test("a response that arrives after the abort is discarded and its body cancelled", async () => {
    const controller = new AbortController();
    let late!: (response: Response) => void;
    const cancel = vi.fn(async () => undefined);
    const response = { body: { cancel } } as unknown as Response;
    const result = abortable(
      () => new Promise<Response>((resolve) => (late = resolve)),
    )(request(controller.signal));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    late(response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("raceAbort carries the abort reason when there is one", async () => {
    const controller = new AbortController();
    const reason = new Error("page hidden");
    const result = raceAbort(
      new Promise<never>(() => undefined),
      controller.signal,
    );
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });
});

describe("the production transports use it by default", () => {
  test("the unstamped API: an activation whose fetch ignores the abort still settles", async () => {
    vi.stubGlobal("fetch", vi.fn(never));
    const api = createUnstampedApi();
    const controller = new AbortController();
    const result = api.activate(
      { grant: "g", verifier: "v" },
      controller.signal,
    );
    expect(await settled(result)).toBe("pending");
    controller.abort();
    expect(await settled(result)).toBe("rejected:AbortError");
  });

  test("the unstamped API: a body that ignores the abort still settles", async () => {
    const controller = new AbortController();
    const headersThenHang = {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => new Promise<string>(() => undefined),
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => headersThenHang),
    );
    const api = createUnstampedApi();
    const result = api.activate(
      { grant: "g", verifier: "v" },
      controller.signal,
    );
    expect(await settled(result)).toBe("pending");
    controller.abort();
    // The body could not be read, which the existing rule treats as a non-Atlas body: an answer with no JSON.
    expect(await settled(result)).toBe("resolved");
  });

  test("the send boundary: the stamped request's time-out or caller abort settles the issued promise", async () => {
    vi.stubGlobal("fetch", vi.fn(never));
    const transport = createIssueTransport();
    const controller = new AbortController();
    const released = vi.fn();
    const issued = transport.issue({
      request: request(controller.signal),
      identityRead: false,
      csrf: "csrf",
      signal: controller.signal,
      refuses: () => false,
      markIssued: () => undefined,
      releaseIssueLock: released,
    });
    expect(issued).not.toBeNull();
    expect(released).toHaveBeenCalledTimes(1);
    expect(await settled(issued as Promise<Response>)).toBe("pending");
    controller.abort();
    expect(await settled(issued as Promise<Response>)).toBe(
      "rejected:AbortError",
    );
  });
});
