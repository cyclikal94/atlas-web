# Profiling on a real device (evidence key `WEB-09a:sync-profiling`, handoff items H1 to H9)

This is how a person with the devices runs the dense-workload measurements that the backend items BE-B1 and BE-Q23 are waiting for. The evidence key is unchanged;
WEB-09c owns it since the WEB-09a closure (BC-20261009). It is **not** run by WEB-09c: that delivery measured on one macOS developer machine with Playwright engines,
and says so in its hand-over (`docs/sync-measurements.md` names the run directory and its hashes). The operator escalated the device roster on 10 October 2026
(OD-1, "Desktop now; escalate roster"; see "The roster" below). The measurement gate stays held until the roster below has run. Who runs it, and on which devices,
is an operator decision.

## What the page does, and what it does not

`/profile-harness` is a **fixture-only** page (`src/fixture/data-harness/profile-page.ts`). It is built into `dist-fixture` and is never part of `dist`: the production
build has one entry (`index.html`) and `scripts/check-no-fixture.mjs` fails any artefact that contains the fixture marker.

Each page load is **one cold run of one workload**. The page:

1. regenerates the workload in the page from `scripts/lib/profile-workloads.mjs` (deterministic: byte-identical on every machine) and checks its SHA-256 against
   `scripts/lib/profile-workload-hashes.json`; a run whose hash does not match is marked `sha256_verified: false` and the validator refuses it. **W2** is not
   generated: it is the batch the released backend produced, captured by the desktop programme and carried in the hand-over. The page reads the capture you picked
   (see "W2: the captured batch" below), hashes it on every run and checks it against the SHA-256 named in the URL; the validator checks it against the hand-over's
   `W2-hashes.json`;
2. runs the **production** processing path on it: the production sync engine, byte scanner, element validator and page commit, writing into **this device's real
   IndexedDB** (a fresh throw-away account database per run, named `atlas-fffffff0-0000-4000-8000-…`);
3. records the outcome (`admitted`, `refused`, `error`, `timeout`), the elapsed time, the scan and commit times the engine reports, the number of requests the engine
   made, the page's own JS heap where the engine exposes it (`performance.memory`: **Chromium only**), and the machine's own description;
4. stores the record in the protocol's state in this origin's `localStorage`, so runs collected over many page loads end up in one results file that the page can
   copy (schema 2: every run carries the protocol's `protocol_id`).

**One tab owns a protocol** (WEB-09c revision 2). The tab that starts it owns it: its token is in that tab's `sessionStorage`, which survives the protocol's
reloads. Every attempt is **reserved** in one write before it runs and its result is stored, with the end of the reservation, in one more write, so a reload or a
killed tab never skips an attempt or records one twice. Any other tab, including a plain `/profile-harness` page, only reads: it does not run, recover, clear or
delete anything, and says which tab owns the protocol. A storage error or an unreadable state stops the protocol with its message; nothing is reset or started
over silently. A completed protocol is never overwritten: copy its results, then **Clear results** before starting another. The W2 capture and the plan never
change after a protocol starts.

**One collector per origin** (revision 3). A page that collects (the protocol, or a single manual run such as `?w=W3&run=1`) first takes the origin's collector
lock (a Web Lock) and keeps it until it is navigated away or closed; restoring a capture, a take-over, **Clear results** and **Delete profiling databases** run
under the same lock. So:

* while a protocol is active (not yet complete), **every manual run is refused**, in another tab and in the owning tab alike, and nothing is run or written;
* while a manual run is in progress, or a manual attempt was left reserved by a closed tab, a protocol does not start (open the manual run's link again in its tab,
  or, if that tab is gone, **Take over or recover** the manual collection, which records the attempt as `killed`; then the protocol starts);
* of two tabs started at the same moment, exactly one collects; the other says "another live page is collecting on this origin" and writes nothing;
* a duplicate of a collecting tab (browsers copy `sessionStorage` when a tab is duplicated) only reads;
* a browser without Web Locks collects and changes nothing (the page cannot establish that it is the only collector, so it never assumes it);
* an unknown workload, a run number that is not one, or a run already recorded is refused before anything is reserved; a manual link reloaded after its
  attempt was reserved records that attempt once as `killed` and runs nothing (revision 4): the menu's links always name an unused run number;
* a result is stored only into the reservation its page made: if the collection was cleared, re-created or taken over while the run was going on, the result is
  shown on that page and **not** stored.

**A lost owning tab** (revision 4: the protocol **and** a manual collection). If the owning tab is lost for good (closed, crashed, the device restarted), open
`/profile-harness` in a new tab and tap **Take over or recover the selected collection**. **Collection** chooses which stored collection an action is for; its
default takes the only one that needs it, and when a protocol and a manual collection both belong to a lost tab the page asks you to choose one and take them over
one at a time. A take-over is refused while the collection's own page is still alive (a page that collected keeps the lock until it is navigated away or closed).
It is one recorded write: the collection moves to this tab with its id, every earlier result and its W2 pin unchanged, and an attempt the lost tab had reserved is
recorded, in the same write, once as `killed` (it is never run again under that identity; a further manual run takes an unused run number). Nothing runs during a
take-over. The same button records an interrupted attempt of this tab's own collection (its page ended) without a take-over. The W2 capture was kept only in the
lost tab: the page then asks you to **choose the same capture file again**. Only the owner can restore it, and only the very file whose SHA-256 the collection pins
is accepted ("W2 capture restored for collection …"); any other file, or another tab, changes nothing. If this tab owns two collections that pin different
captures, choose the one you are restoring with **Collection** (the page says which other collection's capture this tab no longer keeps). Then open the
collection's link (with the same `w2sha256`) to go on. If the page says a capture was written but did not read back, what the tab keeps is uncertain: choose the
file again before a W2 run.

**Copying and clearing** (revision 4). **Copy results JSON** copies the chosen collection: a protocol's results file, or a manual collection's diagnostic export
(its runs with its owner, next attempt and reservation: never a results file). **Copy diagnostic snapshot** copies both collections' raw records and this page's
state. What is copied is also shown in the box under the buttons, so a refused clipboard loses nothing. **Clear results** clears the chosen collection (both by
default), refuses one that another tab owns or that holds an attempt in progress, shows what it removed in the box first, and says exactly which collection it
could not remove if the storage refuses. Copy before you clear.

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
`secure_context` and the validator refuses a file taken in an insecure context. Any of these will do; none is installed by this repository, and the controller
WEB-09c measured on has **no** `mkcert` and **no** Caddy (the operator installs one, or uses the Android `adb reverse` route, which needs neither):

* `pnpm exec vite preview --mode fixture --host 0.0.0.0 --port 4173`, with a TLS-terminating reverse proxy in front (Caddy, nginx or `mkcert` with a local CA that
  the device trusts);
* for an **Android** device on USB: `adb reverse tcp:4173 tcp:4173`, then open `http://localhost:4173/profile-harness` on the device (`localhost` is a secure context);
* for **iOS and iPadOS**: a certificate the device trusts (for example a local CA installed through Settings → General → About → Certificate Trust Settings), or a tunnel
  you choose (an external service is your decision: nothing here depends on one).

## W2: the captured batch

W2 is BE-B1 3(b) and BE-Q23 M3's server-reachable dense batch (one batch of 200 changes, about 1.5 MB). The hand-over carries it:
`handoff/fixtures/W2-captured.<engine>.limit-1.json`, with their SHA-256 in `handoff/fixtures/W2-hashes.json`. Any one of the limit-1 captures will do. The
validator accepts a hash listed in `W2-hashes.json` only after it has **certified** that capture from the hand-over that lists it (revision 4): the bytes are in
the hand-over's `fixtures/` and `evidence/w2/`, its `P-W2 capture` row records that hash with the seeded person, and the bytes are the seeded dense batch (a sync
page whose one batch holding that person is the person and its 199 distinct checklist fields of 100 items labelled "x" with 40 checked ids each:
`scripts/lib/profile-w2-capture.mjs`). From revision 5 the bytes must also be admitted, as they are, by the candidate's production receive path (the byte scan, every
element's decoder and gates: `scripts/lib/production-page-reader.mjs`), so a capture with a duplicated key, a revision such as `12e0` or a byte order mark is
not certified even when its parsed form is the seed. So give `--w2-hashes` the hand-over's own `fixtures/W2-hashes.json`; a copy of that file anywhere else
certifies nothing. The page keeps the file's exact bytes (a byte order mark included) and runs them as they are.

1. Copy the chosen capture onto the device (AirDrop, a USB transfer or `adb push` into Downloads).
2. Open `/profile-harness` in the tab (or installed app) that will run the protocol. Under **W2 capture**, choose the file. The page shows
   `W2 capture kept: <name>, <bytes> bytes, SHA-256 <hex>`; check the hash against `W2-hashes.json`.
3. Start the protocol with the hash in the URL: `/profile-harness?protocol=1&w2sha256=<hex>` (the page's own link carries it once the URL names it).

The page keeps the capture in **that tab's** `sessionStorage`, which survives the protocol's reloads; a new tab does not have it, and a W2 run without it is
recorded as an `error` run, never replaced by anything else. The page reads the capture only on a W2 run, as it holds a generated workload only on its own run.
Nothing is fetched: the page never makes a network request of its own (lint rule R1). Without `w2sha256` the protocol has no W2, the page says so, and the results
are **incomplete**.

The desktop programme runs this exact route: its `device` stage (`node scripts/profile-sync.mjs --evidence <dir> --only device`, after the `integration` stage that
captures W2 into the same directory) picks each engine's own capture on the page and runs the whole protocol in Chromium, Firefox and WebKit, and the hand-over
validates each engine's results with its `W2-hashes.json`. `tests/e2e/fixture.profile-harness.spec.ts` holds the route's controls (a stand-in capture kept, read
back, verified and run; other bytes not verified; no capture kept is an error run; no W2 without a named capture) and, since revision 3, the forced schedules of
one collector per origin (manual runs refused during a protocol, simultaneous starts, no Web Locks, a stale result not stored, a lost tab's capture restored
only from the pinned file, clear and delete serialised, illegal identities refused). None of this is a device run.

## Running a device

1. Close other apps and other tabs of the browser. Charge the device above 50 % and keep it awake. Note the thermal state if the OS shows it.
2. Open the `/profile-harness` path of your HTTPS host. For an **installed web app** run, install it first and open the page from the installed app; note that in the log.
3. Tap **Start the full protocol** (with W2 named, as above). The page runs every workload (five cold runs of each valid one: W1, W2, W3, W4, W6; one run of each W5
   limit and each W7 control), reloading
   itself between runs so each is cold. Keep the page in the foreground. A run that the OS kills (the tab reloads by itself) is a **result**: the page records it as outcome `killed` when it
   next loads, and the protocol moves on to the next run instead of repeating it; note it in the log as well.
4. While **W1** and **W3** run, record the platform's tab memory (peak and what is retained after the run) in the log: Android `adb shell dumpsys meminfo` for the browser's package, iOS
   Instruments (Allocations or Activity Monitor on the tab's process), Firefox `about:memory` or the task manager, Chromium's task manager. Subtract the idle baseline you take
   before the first run.
5. When the page says "Protocol complete", tap **Copy results JSON**, save it as a file, and validate it:

   ```
   node scripts/validate-profile-handoff.mjs results.json --w2-hashes <handoff>/fixtures/W2-hashes.json
   ```

   Exit code 0 means complete and consistent; 1 means a rule was broken, a negative control was not fulfilled, or the results are incomplete (the messages say
   which: a file without five distinct W2 runs is incomplete); `--allow-partial` turns "valid but incomplete" into exit code 2, never a broken rule or a failed
   control. Runs are counted as distinct run numbers of ONE protocol (a duplicated run, a run of another protocol or a schema-1 file is refused). Revision 3:
   the file must be a protocol's (not a manual collection), hold its attempts in plan order with its planned count, and say `complete` exactly when it holds
   every attempt; every run must carry the figures its path and outcome produce (an engine run that was admitted has its request, limit, scan and commit times
   and written count; W5 makes no request and commits nothing; a killed attempt measured nothing). A missing figure is an explicit `null`. A W7 control
   fulfils its control only when it was **refused**: an admitted, timed-out, failed or killed control stays in the file and is reported as `FAILED CONTROL`.
   What a run is expected to do comes from the workload, never from the file. A W2 run is checked against `W2-hashes.json` and cannot be validated without it;
   a W2 capture whose bytes are not the ones the protocol names is an `error` run and is not processed. Revision 4: a listed hash counts only for a capture the
   hand-over certifies (see "W2: the captured batch"); a limit-80 capture is never the device page's W2.
6. Tap **Delete profiling databases** to remove the throw-away databases from the device.

## Multi-tab runs (H5) and the contention items P-6 to P-9

The single-page protocol does not cover 2 or 3 tabs of one account, a leader syncing while others render, a backgrounded or frozen tab, or an installed app plus a tab. The **production** sync leader is WEB-09b's, so
the production arrangement is **not run** and nobody should read its absence as a pass.

There is a **desktop** programme for the contention items, `node scripts/profile-contention.mjs --evidence <dir>` (spec `tests/e2e/fixture.profile-contention.spec.ts`, Chromium, Firefox and WebKit, one worker,
written under `<dir>/contention/`; `--evidence` is required and a directory that already records the stage is refused). Every result is labelled with what stood in for the real thing:

| Item | What it measures | What stands in for the real thing |
| --- | --- | --- |
| P-6 | how often a page meets an unresolved lease that it did not create (a tab closed mid-request; a live page with slow or failing response handling) | **injected** slowness and failure; a closed or killed tab's lease does not block an observer's ordinary request, the observer's cover carries the unresolved lease; one real Chromium renderer crash |
| P-7 | the wait for another page's activity against a back-to-back sync leader, and how often a closing write gives up against a frozen owner | a **fixture** leader (pages 5 ms apart); a **synthetic** freeze (a main-thread block, not a bfcache freeze); the production 20 s wait in one case, a **scaled** wait elsewhere |
| P-8 | what is cancelled and retired when pages queue behind one another | the same fixture leader |
| P-9 | the yield between pages (none, macrotask, `scheduler.yield`, idle) against other pages' waits and catch-up throughput | the same fixture leader, on a desktop |
| P-13 | what a **healthy follower** reads because of `atlas-sync` hints (a leader's pages, drafts and receipts, stop-record hints, none), and the leader's catch-up with 0, 1 and 2 followers | the same fixture leader; the stop-record hints are **synthetic** (posted by a test-side channel, the record unchanged); counted by test-side instrumentation in the follower page |

What it does **not** show, and what stays a gate: a **real** freeze or back/forward-cache restore, any **mobile** device (the roster above), a loaded or throttled CPU, and the **production leader** (WEB-09b). A device run of the contention spec
is possible by hosting `dist-fixture/` as above and running the spec against it, but is not packaged for a person without a checkout; that is also open.

## The roster (H1): escalated (OD-1)

Fill one row per device and attach its results file. The roster that BE-B1 and BE-Q23 need is named by Kieran or product; the floor devices (the lowest-memory
**supported** device per family) must be named by them too. **No roster or floor device is named in any approved input**, `docs/browser-support.md` leaves its
tested-versions table unfilled by design, and no device is attached to the controller. On 10 October 2026 Kieran chose "Desktop now; escalate roster" (OD-1): WEB-09c
delivered the desktop programme and this package, and the following are needed before a device run:

1. the named floor device for each family (model, RAM, OS);
2. the mid-range mobile;
3. who runs the protocol, and where;
4. the HTTPS hosting choice (a local CA that the device trusts, or Android `adb reverse`; an external tunnel is the operator's call).

Until then BE-B1 item 2 and BE-Q23 M1 are `escalated` in the hand-over, `needs_finer_pagination` is undetermined for supported devices, and BE-B1 and BE-Q23 stay blocked.

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
