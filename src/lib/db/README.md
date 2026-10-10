# Local storage

The per-account database, the ordinary delta sync and the draft outbox live in `src/data/` (WEB-09a); `docs/data-layer.md` describes them.
The bootstrap opens no database. A page obtains an account's database only through `openAccountData`, only for the displayed account, and
the database is created only while the may-create predicate holds (the short-lived handles of the deletion ports open an existing database
and never create one). `dexie` is imported only by `src/data/store/dexie-adapter.ts` and `src/data/ui/`, and it is not in the initial chunk
(`pnpm check:artefacts`).

A write into an account's database that originates from a response (a delta page, a receipt) is ordered against every change of the settled identity by the session's **persistence hold**
(`Session.persistence`, a shared `atlas-auth` lock kept until the data transaction completes), so no commit lands after a transition that was settled before it. The only other browser
storage the data layer uses is a small `localStorage` marker, keyed by account and operation and holding no content, that records a local write failure when even IndexedDB cannot record it.

Account lifecycle coordination (the wipe, the draft fence, consent) belongs to WEB-08a and WEB-08c; WEB-09a registers the real ports it calls.
