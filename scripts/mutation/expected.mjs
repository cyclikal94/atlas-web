// The INDEPENDENT expected size of each mutation catalogue (`data-catalogue.mjs`): a catalogue that lost or gained an entry by accident
// fails against it. Change a count only together with the catalogue entries it accounts for (WEB-10a revision 11, R24). The real-engine
// driver (`run-engine-mutants.mjs`, an adopted routing hook) keeps its own copy of the engine count.
export const EXPECTED_UNIT = 3042;
export const EXPECTED_ENGINE = 331;
// WEB-10b: +34 unit (MU-2501..MU-2532, MU-2535, MU-2536) and +3 real-engine (MU-2534, MU-2537, MU-2538) in `catalogue-web10b.mjs`.
// WEB-10b revision 1 (review R1-R5): +10 unit (MU-2539..MU-2546, MU-2549, MU-2550) and +2 real-engine (MU-2547 N-LS1, MU-2548 N-LS2).
// WEB-10b revision 2 (review 2 R1/R2): +10 unit (MU-2551..MU-2559, MU-2562) and +2 real-engine (MU-2560, MU-2561 over E-LS11); MU-2534 re-anchored.
// WEB-10b revision 4 (review 4, D1 / DA-N1): +6 unit (MU-2578..MU-2583) and +2 real-engine (MU-2584, MU-2585 over E-LS13); MU-2515 and MU-2543 re-anchored.
// WEB-11a / accepted WEB-10b merge: 1,944 + 73 unit; 276 + 11 engine. Both catalogues retained; colliding People IDs mapped separately.
// WEB-11a revision 17 (review 16, R16.1): +20 unit (MU-2840..MU-2859); MU-2465, MU-2486..2487, MU-2587..2589, MU-2604, MU-2665, MU-2836 and the real-engine MU-2742 re-expressed.
// Combined inventory: accepted WEB-10b (1737 unit, 255 engine) plus WEB-08d (105 unit, 5 engine).
// WEB-11a / accepted WEB-08d merge: 2037 + 105 unit; 287 + 5 engine. Both catalogues retained; IDs do not overlap.
// WEB-11a revision 18 (review 17, R17.1): +10 unit (MU-2860..MU-2869); MU-2842 and MU-2843 re-anchored.
// WEB-11a revision 19 (review 19, R19.1): +5 unit (MU-2870..MU-2874).
// WEB-11a revision 20 (review 20, R20.1): +9 unit (MU-2875..MU-2883).
// WEB-11a revision 21 (review 21, R21.1): +5 unit (MU-2884..MU-2888).
// WEB-11a revision 22 (review 22, R22.1): +7 unit (MU-2889..MU-2895).
// WEB-11a revision 23 (review 23, R23.1): +16 unit (MU-2896..MU-2911).
// WEB-11a revision 24 (review 24, R24.1): +10 unit (MU-2912..MU-2920, MU-2922).
// WEB-11a revision 25 (review 25, R25.1): +15 unit (MU-2923..MU-2937).
// WEB-11a revision 26 (review 26, R26.1/R26.2): +16 unit (MU-2938..MU-2953); MU-2933 and MU-2936 re-anchored.
// WEB-11a revision 27 (review 28, R28.1): +4 real-engine (MU-2954..MU-2957) over S-GATE "R28.1" and "visible: the gate STAYS UP".
// Accepted WEB-10b merge: retain WEB-14a's 321 unit / 5 engine additions and WEB-10b's 73 unit / 11 engine additions over the common base.
// Accepted WEB-08d merge: another 105 unit and 5 engine entries, combined 2163 unit / 265 engine.

// WEB-14a integration with accepted WEB-11a: 2235 + 321 unit; 296 + 5 engine. Both complete parent catalogues retained.
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
// WEB-10c revision 17 (review 18 R36-K; Kieran's decision approval/web10c-r36k-conservative-recovery-20261102.json): +17 unit
// (MU-3316..MU-3332; MU-3316 made in both lock guards); MU-3244, MU-3245, MU-3246, MU-3248, MU-3258, MU-3259, MU-3277 and MU-3290 re-anchored, and real-engine MU-3261 (the same
// faults over the caller's two fence operations and the protected outcome's marker operation).
// WEB-10c revision 18 (review 19 R36-L; design assessment of 3 November 2026): +14 unit (MU-3333..MU-3346: the paused-record settling at
// each entry, its record, lock, witness and binding checks, the lost-call pause predicates and the per-caller lift rule); MU-3008, MU-3225
// and MU-3324 re-anchored (the same faults over the stopped row's settling and the per-caller lift rule).
// WEB-10c revision 19 (review 20 R40/R41; design assessment of 3 November 2026): +9 unit (MU-3347..MU-3355: the idle timer's boundary
// clock, Start judged at the press and at its own instant, and the strip's opening/closing boundaries, overtaken read, wake and backwards clock).
// WEB-10c base merge of 5 November 2026: accepted main (2235 unit, 296 engine) plus WEB-10c (332 unit, 9 engine) = 2567 unit, 305 engine.
// Both catalogues retained; IDs do not overlap (MU-3001..MU-3355 against WEB-11a's MU-2101..MU-2957).
// WEB-10c revision 20 (review 22 R42; design assessment of 5 November 2026): +11 unit (MU-3356..MU-3365, MU-3368: the strip's status rule with a strip
// retained, its own Try again, the paced attempts after a lapsed strip's re-read did not complete, the wake listeners kept, the ladder's
// cleanup with the scope, unknown never shown as empty, and the no-database presentation, and the boundary wait re-armed after a read that did not complete); MU-3359, MU-3360, MU-3362 and MU-3363 re-anchored to the unified watcher; +2 real-engine (MU-3366, MU-3367 over E-S4).
// WEB-11b: +28 unit (MU-4101..MU-4121, MU-4123, MU-4124, MU-4126, MU-4128..MU-4130, MU-4135) and +4 real-engine (MU-4131..MU-4134, N-R1..N-R4) in
// `catalogue-web11b.mjs`; MU-4122, MU-4125 and MU-4127 are not catalogued (reasons in that module).
// WEB-11b revision 1 (review 1, R1–R4, and N1): +11 unit (MU-4136..MU-4149 but MU-4145..MU-4147, which are real-engine); MU-4104, MU-4105, MU-4124, MU-4130 and MU-4135 re-anchored (same defects); +4 real-engine (MU-4145, MU-4146 over E-R15b; MU-4147 over E-R14; MU-4150 over E-R17).
// WEB-11b revision 2 (review 2, R7 and R2, and DA-N1): +7 unit (MU-4151..MU-4157); MU-4135, MU-4148 and MU-4150 re-anchored (same defects); +1 real-engine (MU-4158 over E-R18).
// WEB-11b revision 3 (review 3, R7: failed-read Try again): +10 unit (MU-4159..MU-4168) and +2 real-engine (MU-4169, MU-4170 over E-R20).
// WEB-11b revision 4 (review 4, R1: sender name-choice ownership): +7 unit (MU-4171..MU-4177) and +1 real-engine (MU-4178 over E-R21).
// WEB-14a revision 55 base merge of accepted main (WEB-09c, WEB-11b): 2298 + 321 unit; 308 + 5 engine. Both complete parent catalogues retained.
// WEB-19 (the People activity timeline): +17 unit (MU-6101..MU-6117) and +3 real-engine (MU-6151..MU-6153 over E-AC8, E-AC4, E-AC5) in
// `catalogue-web19.mjs`.
// WEB-19 revision 1 (review 1, R-1: a refresh remounted the timeline): +8 unit (MU-6118..MU-6125) and +1 real-engine (MU-6154 over E-AC9);
// MU-6114 and MU-6152 re-anchored (the same defect: the withholding test now sits two spaces further in, in the one flat list).
// WEB-10c maintenance merge of accepted main 2c4e7fb (5 November 2026): base a7e0b7d (2235 unit, 296 engine) plus WEB-10c (343 unit, 11 engine) plus
// WEB-11b (63 unit, 12 engine) = 2641 unit, 319 engine, counted from the merged catalogue; IDs do not overlap (MU-3001..MU-3368 against MU-4101..MU-4178).
// WEB-18: +33 unit (MU-7001..MU-7025, MU-7027..MU-7034; MU-7026 not created: identical to MU-3017) and +3 real-engine (MU-7101..MU-7103) in
// `catalogue-web18.mjs`; WEB-10c's MU-3018 re-anchored (the same fault over the editor's new start).
// WEB-18 revision 1 (review 1, F-R2..F-R4): +6 unit (MU-7036..MU-7041; MU-7035 was withdrawn in Running and is not reused).
// WEB-19 maintenance merge of accepted main 3f8fdf94 (5 November 2026): base 2c4e7fb (2298 unit, 308 engine) plus WEB-19 (25 unit, 4 engine) plus
// WEB-10c (343 unit, 11 engine) = 2666 unit, 323 engine, counted from the merged catalogue; IDs do not overlap (MU-6101..MU-6154 against MU-3001..MU-3368).
// WEB-18 revision 2 base merge of accepted main 74b0bac (6 November 2026): base 74b0bac (2666 unit, 323 engine) plus WEB-18 (39 unit,
// 3 engine) = 2705 unit, 326 engine, counted from the merged catalogue; IDs do not overlap (MU-7001..MU-7103 against MU-6101..MU-6154).
// WEB-14a maintenance merge of accepted main 74b0baca (6 November 2026): base 2c4e7fb (2298 unit, 308 engine) plus WEB-14a (321
// unit, 5 engine) plus WEB-10c (343 unit, 11 engine) plus WEB-19 (25 unit, 4 engine) = 2987 unit, 328 engine, counted from the merged catalogue.
// WEB-14a's MU-3001..MU-3024 collided with WEB-10c's and become MU-4001..MU-4024 (`id-migrations.json`; patches and tests unchanged); no other
// ID overlaps (MU-4001..MU-4024 against MU-4101..MU-4178 and MU-6101..MU-6154).
// WEB-14a merge correction D-1 (6 November 2026; WEB-10c's dependency editor and turn order dialog recoverable around an app update): +10 unit
// (MU-3801..MU-3810) = 2997 unit, 328 engine.
// WEB-14a revision 57 (Review 57, F-R57-1: a restored editor's focus target is never inside a recovery surface): +6 unit (MU-3811..MU-3816)
// = 3003 unit, 328 engine.
// WEB-18 maintenance merge of accepted main 2f42ac35 (7 November 2026): base 74b0baca (2666 unit, 323 engine) plus WEB-18 (39 unit,
// 3 engine) plus WEB-14a with D-1 and revision 57 (337 unit, 5 engine) = 3042 unit, 331 engine, counted from the merged catalogue; IDs do not
// overlap (MU-7001..MU-7103 against MU-1296..MU-4024 and MU-3801..MU-3816).
