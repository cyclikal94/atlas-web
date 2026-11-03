// The INDEPENDENT expected size of each mutation catalogue (`data-catalogue.mjs`): a catalogue that lost or gained an entry by accident
// fails against it. Change a count only together with the catalogue entries it accounts for (WEB-10a revision 11, R24). The real-engine
// driver (`run-engine-mutants.mjs`, an adopted routing hook) keeps its own copy of the engine count.
export const EXPECTED_UNIT = 2281;
export const EXPECTED_ENGINE = 305;
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
// WEB-11b: +28 unit (MU-4101..MU-4121, MU-4123, MU-4124, MU-4126, MU-4128..MU-4130, MU-4135) and +4 real-engine (MU-4131..MU-4134, N-R1..N-R4) in
// `catalogue-web11b.mjs`; MU-4122, MU-4125 and MU-4127 are not catalogued (reasons in that module).
// WEB-11b revision 1 (review 1, R1–R4, and N1): +11 unit (MU-4136..MU-4149 but MU-4145..MU-4147, which are real-engine); MU-4104, MU-4105, MU-4124, MU-4130 and MU-4135 re-anchored (same defects); +4 real-engine (MU-4145, MU-4146 over E-R15b; MU-4147 over E-R14; MU-4150 over E-R17).
// WEB-11b revision 2 (review 2, R7 and R2, and DA-N1): +7 unit (MU-4151..MU-4157); MU-4135, MU-4148 and MU-4150 re-anchored (same defects); +1 real-engine (MU-4158 over E-R18).
