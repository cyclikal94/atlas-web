// The INDEPENDENT expected size of each mutation catalogue (`data-catalogue.mjs`): a catalogue that lost or gained an entry by accident
// fails against it. Change a count only together with the catalogue entries it accounts for (WEB-10a revision 11, R24). The real-engine
// driver (`run-engine-mutants.mjs`, an adopted routing hook) keeps its own copy of the engine count.
export const EXPECTED_UNIT = 2018;
export const EXPECTED_ENGINE = 264;
// WEB-10b: +34 unit (MU-2501..MU-2532, MU-2535, MU-2536) and +3 real-engine (MU-2534, MU-2537, MU-2538) in `catalogue-web10b.mjs`.
// WEB-10b revision 1 (review R1-R5): +10 unit (MU-2539..MU-2546, MU-2549, MU-2550) and +2 real-engine (MU-2547 N-LS1, MU-2548 N-LS2).
// WEB-10b revision 2 (review 2 R1/R2): +10 unit (MU-2551..MU-2559, MU-2562) and +2 real-engine (MU-2560, MU-2561 over E-LS11); MU-2534 re-anchored.
// WEB-10b revision 4 (review 4, D1 / DA-N1): +6 unit (MU-2578..MU-2583) and +2 real-engine (MU-2584, MU-2585 over E-LS13); MU-2515 and MU-2543 re-anchored.
// Accepted WEB-10b + WEB-13b: 1664 + 73 + 105 unit; 244 + 11 + 4 native.
// WEB-13b IDs MU-2501..MU-2551 moved to MU-2586..MU-2636 at the accepted-main merge; historical evidence keeps the old IDs.
// WEB-13b revision 6 (review 6 R7): +19 unit (MU-2637..MU-2655) in `catalogue-web13b-r6.mjs`; MU-2464, MU-2472, MU-2474, MU-2475 moved to
// the import editing session and MU-2471 re-anchored at the corrected text (same defects).
// Combined inventory: accepted WEB-10b (1737 unit, 255 engine), WEB-08d (105 unit, 5 engine) and WEB-13b (124 unit, 4 engine).
// WEB-13b revision 7 (review 7 R7): +13 unit (MU-2656..MU-2668) in `catalogue-web13b-r7.mjs`; MU-2646 re-anchored at the corrected
// observation (same defect). WEB-13b now 137 unit, 4 engine.
// WEB-13b revision 8 (review 8 R7a/R7b; DA-N2/DA-N3 by WEB13B-R7B-N2-N3-ASSIGNMENT-20261027): +19 unit (MU-2669..MU-2687) in
// `catalogue-web13b-r8.mjs`; MU-2657/2658/2659/2660/2664/2665/2668 (r7), MU-2646 (r6), MU-2471 (r1) and MU-1225 (WEB-09b) re-anchored at the
// corrected code (same defects); MU-2666 re-expressed (its old oracle rewarded the loss of input). WEB-13b now 156 unit, 4 engine.
// WEB-13b revision 9 (review 9 R7c; C2 by MORNING-TASK-APPROVALS-20261028): +20 unit (MU-2688..MU-2707) in `catalogue-web13b-r9.mjs`;
// MU-2658, MU-2662 (r7), MU-2676, MU-2678, MU-2679 (r8) re-anchored at the corrected code (same defects). WEB-13b now 176 unit, 4 engine.
