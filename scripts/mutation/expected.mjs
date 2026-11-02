// The INDEPENDENT expected size of each mutation catalogue (`data-catalogue.mjs`): a catalogue that lost or gained an entry by accident
// fails against it. Change a count only together with the catalogue entries it accounts for (WEB-10a revision 11, R24). The real-engine
// driver (`run-engine-mutants.mjs`, an adopted routing hook) keeps its own copy of the engine count.
export const EXPECTED_UNIT = 2134;
export const EXPECTED_ENGINE = 269;
// WEB-10b: +34 unit (MU-2501..MU-2532, MU-2535, MU-2536) and +3 real-engine (MU-2534, MU-2537, MU-2538) in `catalogue-web10b.mjs`.
// WEB-10b revision 1 (review R1-R5): +10 unit (MU-2539..MU-2546, MU-2549, MU-2550) and +2 real-engine (MU-2547 N-LS1, MU-2548 N-LS2).
// WEB-10b revision 2 (review 2 R1/R2): +10 unit (MU-2551..MU-2559, MU-2562) and +2 real-engine (MU-2560, MU-2561 over E-LS11); MU-2534 re-anchored.
// WEB-10b revision 4 (review 4, D1 / DA-N1): +6 unit (MU-2578..MU-2583) and +2 real-engine (MU-2584, MU-2585 over E-LS13); MU-2515 and MU-2543 re-anchored.
// WEB-10c: +73 unit and +3 real-engine entries, retained alongside WEB-10b.
// WEB-10c revision 3 (review 3 R14-R18, design assessment DA-T3): +17 unit (MU-3085..MU-3101); MU-3012, MU-3016, MU-3038, MU-3061, MU-3072,
// MU-3079..MU-3082 re-anchored (the same faults over the moved guards).
// WEB-10c revision 4 (review 4 R19-R22): +19 unit (MU-3102..MU-3120); MU-3084 and MU-3091 re-anchored (the same faults over the moved lines); MU-3008's injected `drive` call given revision 3's binding argument.
// WEB-10c revision 5 (review 5 R23-R26): +25 unit (MU-3121..MU-3145); MU-3079, MU-3084, MU-3105 and MU-3119 re-anchored (the same faults over the moved
// guards).
// WEB-10c revision 6 (review 6 R27-R30): +20 unit (MU-3146..MU-3163, MU-3165, MU-3166; MU-3164 retired in the catalogue with its reason); MU-3060, MU-3062, MU-3082, MU-3115, MU-3119, MU-3123, MU-3125, MU-3128,
// MU-3130, MU-3137, MU-3138 and MU-3140 re-anchored (the same faults over the moved lines; MU-3123 and MU-3125 each in its own resolver's
// use of the now shared loss rule).
// WEB-10c revision 7 (review 7 R31/R32): +16 unit (MU-3167..MU-3182); MU-28 (the enqueue plan's read gained the timer end's drafts) and MU-3111
// (the authority decoder moved into `timerAuthorityOf`) re-anchored (the same faults over the moved lines).
// WEB-10c revision 8 (review 8 R33): +11 unit (MU-3183..MU-3193); MU-3026 re-anchored (the attempt is now taken by `memory.ts` `startRota`).
// WEB-10c revision 9 (review 9 R34): +6 unit (MU-3194..MU-3199); MU-3188 re-anchored (the completion also asks which input the change represents).
// WEB-10c revision 10 (review 11 R36, Decision B): +27 unit (MU-3200..MU-3226); MU-3003, MU-3004, MU-3006, MU-3010, MU-3036, MU-3063, MU-3080,
// MU-3081, MU-3099, MU-3101 and MU-3165 re-anchored (the same faults over the moved lines).
// WEB-10c revision 11 (review 12 R36): +33 unit (MU-3227..MU-3259) and +2 real-engine (MU-3260, MU-3261 over E-M11).
// WEB-10c revision 12 (review 13 R36-A to R36-D): +9 unit (MU-3262..MU-3270); MU-3101, MU-3219, MU-3221, MU-3241, MU-3243, MU-3247, MU-3248,
// MU-3250 and MU-3257 re-anchored (the same faults over the protected-outcome and queue code).
// WEB-10c revision 13 (review 14 R36-E/R36-F, finding F-10C-13a): +12 unit (MU-3271..MU-3282; MU-3281 over the outbox dispatcher's
// retry); MU-3243, MU-3247, MU-3257, MU-3262 and MU-3269 re-anchored (the same faults over the outcome protected from its receipt), and
// WEB-09a's MU-830, MU-831 and MU-832 re-anchored (the same faults over the dispatcher's page memory narrowed to the outbox's operations).
// WEB-10c revision 14 (review 15 R36-G; the Firefox teardown found qualifying R38): +7 unit (MU-3283..MU-3289); MU-3262, MU-3271 and
// MU-3274 re-anchored (the same faults over the revised receipt and repair code); MU-3272's text unchanged (its anchor is unique again).
// WEB-10c revision 15 (review 16 R36-H, R36-I, R39): +13 unit (MU-3290..MU-3302); MU-3262, MU-3269, MU-3283, MU-3288 and MU-3289 re-anchored (MU-3288
// relabelled: the fault is now a fence at the first failed write AFTER the page's pagehide); MU-3284 and MU-3285 given the cases where
// their faults are observable now (after a pagehide). +2 real-engine (MU-3304 over E-M12b, MU-3305 over E-M12c; MU-3303 over E-M2 retired: Chromium-only, see the catalogue).
// WEB-10c revision 16 (review 17 R36-J; Kieran's D1 decision): +5 unit (MU-3306, MU-3307, MU-3308, MU-3310, MU-3314); MU-3301 retired (see the
// catalogue; MU-3309, MU-3311, MU-3312 of this revision's first design retired with it, never counted); MU-3262, MU-3269, MU-3282, MU-3283,
// MU-3288, MU-3289, MU-3291, MU-3292, MU-3293, MU-3295, MU-3296 and MU-3302 re-anchored (the same faults over the departure code).
// +2 real-engine (MU-3313 over E-M12f, MU-3315 over E-M12h); MU-3304 and MU-3305 re-anchored.
// Combined inventory: accepted WEB-10b (1737 unit, 255 engine), WEB-08d (105 unit, 5 engine), and WEB-10c (214 unit, 3 engine).
