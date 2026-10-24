// WEB-10a revision 26's mutant (Review 26 R38 and the design assessment after it: the maintained calendar S13 test states its count from
// the moment Manage shows the waiting change, holding the attempt being answered until then), in the form and under the rules of
// `data-catalogue.mjs`, which spreads it into its `UNIT` list. Kept in its own module as revisions 16 to 25's are. `sub` is the
// catalogue's own exactly-one-occurrence patcher.
import { sub } from "./data-catalogue.mjs";

/**
 * Unit mutant (layer L1b, the production Manage dialog over the IndexedDB double): MU-2436. The other half of S13's sensitivity is the
 * existing MU-1378 (Manage's admission ignored), which the corrected test's post-boundary count must catch; this one checks the
 * control: with a retry loop that never asks again, the no-waiting-change control (and only it) fails, so a dead loop cannot pass
 * S13 by sending nothing.
 */
export const UNIT_R26 = [
  {
    id: "MU-2436",
    title:
      "WEB-10a rev 26 (R38): a calendar request answered `not_sent` is never asked again (S13's no-waiting-change control keeps asking)",
    file: "src/features/calendars/api.ts",
    tests: ["tests/features/calendars/manage-revision-2.test.tsx"],
    expect: /its control keeps asking/,
    patch: (t) =>
      sub(
        t,
        "    const delay = NOT_SENT_DELAYS_MS[attempt];\n",
        "    const delay = NOT_SENT_DELAYS_MS[attempt + NOT_SENT_DELAYS_MS.length];\n",
      ),
  },
];
