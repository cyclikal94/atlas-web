# Profiling on a real device (WEB-09a, handoff items H1 to H9)

This is how a person with the devices runs the dense-workload measurements that the backend items BE-B1 and BE-Q23 are waiting for. It is **not** run by the
WEB-09a delivery: that delivery measured on one macOS developer machine with Playwright engines, and says so (`.agtx/evidence/WEB-09a/profiling/handoff/report.md`).
The measurement gate stays held until the roster below has run. Who runs it, and on which devices, is an operator decision.

## What the page does, and what it does not

`/profile-harness` is a **fixture-only** page (`src/fixture/data-harness/profile-page.ts`). It is built into `dist-fixture` and is never part of `dist`: the production
build has one entry (`index.html`) and `scripts/check-no-fixture.mjs` fails any artefact that contains the fixture marker.

Each page load is **one cold run of one workload**. The page:

1. regenerates the workload in the page from `scripts/lib/profile-workloads.mjs` (deterministic: byte-identical on every machine) and checks its SHA-256 against
   `scripts/lib/profile-workload-hashes.json`; a run whose hash does not match is marked `sha256_verified: false` and the validator refuses it;
2. runs the **production** processing path on it: the production sync engine, byte scanner, element validator and page commit, writing into **this device's real
   IndexedDB** (a fresh throw-away account database per run, named `atlas-fffffff0-0000-4000-8000-…`);
3. records the outcome (`admitted`, `refused`, `error`, `timeout`), the elapsed time, the scan and commit times the engine reports, the number of requests the engine
   made, the page's own JS heap where the engine exposes it (`performance.memory`: **Chromium only**), and the machine's own description;
4. appends the record to this origin's `localStorage`, so runs collected over many page loads end up in one results file that the page can copy.

What it does **not** do, and the figures must not be read as if it did:

* **The transport is an in-page function.** The real stamped request wrapper (`session.api.fetchFor`), with its extra buffer copy, is **not** present. The desktop runs
  made by `pnpm profile:sync` go through the real wrapper and quantify that copy.
* **Memory is what the page can see.** `performance.memory` exists in Chromium only. Peak and retained **tab** memory must be taken with the platform's own tool and
  written beside the run (see the log template).
* **It does not run the first snapshot** (that is WEB-09b's). Workloads W5 (dense snapshot pages at each candidate `limit`) exercise the shared processing path (scan, then
  validate every change) and not a snapshot activation.
* It is a single tab. Multi-tab behaviour (H5) needs the separate protocol in "Multi-tab runs" below.

## Building and hosting

Every command is prefixed with the pinned runtime; the default Node on a developer machine can be a different major version and passes silently.

```
export PATH=/Users/kieran/.nvm/versions/node/v22.23.2/bin:$PATH ; node --version      # must print v22.23.2
pnpm install --frozen-lockfile
pnpm build:fixture                                                                      # writes dist-fixture/
```

Serve `dist-fixture/` over **HTTPS** (Web Locks and Web Crypto need a secure context; `localhost` is one, a LAN address over plain HTTP is not). The page reports
`secure_context` and the validator refuses a file taken in an insecure context. Any of these will do; none is installed by this repository:

* `pnpm exec vite preview --mode fixture --host 0.0.0.0 --port 4173`, with a TLS-terminating reverse proxy in front (Caddy, nginx or `mkcert` with a local CA that
  the device trusts);
* for an **Android** device on USB: `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/profile-harness` on the device (`localhost` is a secure context);
* for **iOS and iPadOS**: a certificate the device trusts (for example a local CA installed through Settings → General → About → Certificate Trust Settings), or a tunnel
  you choose (an external service is your decision: nothing here depends on one).

## Running a device

1. Close other apps and other tabs of the browser. Charge the device above 50 % and keep it awake. Note the thermal state if the OS shows it.
2. Open the `/profile-harness` path of your HTTPS host. For an **installed web app** run, install it first and open the page from the installed app; note that in the log.
3. Tap **Start the full protocol**. The page runs every workload (five cold runs of each valid one: W1, W3, W4, W6; one run of each W5 limit and each W7 control), reloading
   itself between runs so each is cold. Keep the page in the foreground. A run that the OS kills (the tab reloads by itself) is a **result**: the page records it as outcome `killed` when it
   next loads, and the protocol moves on to the next run instead of repeating it; note it in the log as well.
4. While **W1** and **W3** run, record the platform's tab memory (peak and what is retained after the run) in the log: Android `adb shell dumpsys meminfo` for the browser's package, iOS
   Instruments (Allocations or Activity Monitor on the tab's process), Firefox `about:memory` or the task manager, Chromium's task manager. Subtract the idle baseline you take
   before the first run.
5. When the page says "Protocol complete", tap **Copy results JSON**, save it as a file, and validate it:

   ```
   node scripts/validate-profile-handoff.mjs results.json
   ```

   Exit code 0 means complete and consistent; 1 means a rule was broken (the messages say which); `--allow-partial` turns "valid but incomplete" into exit code 2.
6. Tap **Delete profiling databases** to remove the throw-away databases from the device.

## Multi-tab runs (H5) and the contention items P-6 to P-9

The single-page protocol does not cover 2 or 3 tabs of one account, a leader syncing while others render, a backgrounded or frozen tab, or an installed app plus a tab. The **production** sync leader is WEB-09b's, so
the production arrangement is **not run** and nobody should read its absence as a pass.

The revision of WEB-09a did add a **desktop** programme for the contention items, `pnpm profile:contention` (spec `tests/e2e/fixture.profile-contention.spec.ts`, Chromium, Firefox and WebKit, one worker, written under
`.agtx/evidence/WEB-09a/profiling/contention/`). Every result is labelled with what stood in for the real thing:

| Item | What it measures | What stands in for the real thing |
| --- | --- | --- |
| P-6 | how often a page meets an unresolved lease that it did not create (a tab closed mid-request; a live page with slow or failing response handling) | **injected** slowness and failure; a closed or killed tab's lease does not block an observer's ordinary request, the observer's cover carries the unresolved lease; one real Chromium renderer crash |
| P-7 | the wait for another page's activity against a back-to-back sync leader, and how often a closing write gives up against a frozen owner | a **fixture** leader (pages 5 ms apart); a **synthetic** freeze (a main-thread block, not a bfcache freeze); the production 20 s wait in one case, a **scaled** wait elsewhere |
| P-8 | what is cancelled and retired when pages queue behind one another | the same fixture leader |
| P-9 | the yield between pages (none, macrotask, `scheduler.yield`, idle) against other pages' waits and catch-up throughput | the same fixture leader, on a desktop |

What it does **not** show, and what stays a gate: a **real** freeze or back/forward-cache restore, any **mobile** device (the roster above), a loaded or throttled CPU, and the **production leader** (WEB-09b). A device run of the contention spec
is possible by hosting `dist-fixture/` as above and running the spec against it, but is not packaged for a person without a checkout; that is also open.

## The roster (H1)

Fill one row per device and attach its results file. The roster that BE-B1 and BE-Q23 need is named by Kieran or product; the floor devices (the lowest-memory
**supported** device per family) must be named by them too.

| Engine and version | OS and version | Hardware | RAM | `deviceMemory` (or "absent") | `hardwareConcurrency` | Installed app or tab | Class assigned | Run by | Date | Results file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

Families: Chrome and Edge, Firefox and Safari (current and previous major), Chrome on Android, Safari on iOS and iPadOS including the installed app, the lowest-memory
supported device of each family, a mid-range mobile, one desktop, and a browser with **no device-memory signal** (where the client's own rung assumption is exercised).

## The per-run log (H2)

One row per run of W1 and W3 (the others are optional).

| Workload | Run | Platform tool | Idle baseline | Peak tab memory | Retained after | Outcome (admitted, refused, reload, tab killed, time-out) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

## What the figures decide, and what they do not

The results feed H4 (the granularity sweep), H8 (the smallest response the client cannot process) and H9 (the derived values per class and tab count). They are reported, not
judged: nothing in this repository sets a pass mark, and a result obtained with ordinary list pagination, with the in-page transport, on an emulated device, on one tab, or without
the engine and fixture hashes is not accepted evidence (BE-Q23 §9.3).
