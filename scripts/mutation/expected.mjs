// The INDEPENDENT expected size of each mutation catalogue (`data-catalogue.mjs`): a catalogue that lost or gained an entry by accident
// fails against it. Change a count only together with the catalogue entries it accounts for (WEB-10a revision 11, R24). The real-engine
// driver (`run-engine-mutants.mjs`, an adopted routing hook) keeps its own copy of the engine count.
export const EXPECTED_UNIT = 1769;
export const EXPECTED_ENGINE = 249;
// Integration: 1664 + 105 WEB-08d unit entries; 244 + 5 WEB-08d engine entries. No shared IDs were dropped.
