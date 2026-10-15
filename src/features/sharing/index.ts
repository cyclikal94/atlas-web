/**
 * WEB-12a's PUBLIC INTERFACE for WEB-10, WEB-11 and WEB-12b (docs/sharing.md). Import the sharing editors from here, never from a deeper
 * path. The capture a queued create attaches is the data layer's (`captureDefaults(useSharingDefaults().record, kinds)` from
 * `src/data`), because it belongs with the outbox it feeds.
 *
 * Also public: `AudienceChooser` (WEB-10a R22), imported from `./AudienceChooser` itself. The editors below are part of the shell's first
 * load, and a re-export here puts the chooser there too (measured on the fixture's initial JavaScript); its only user is a lazy screen.
 */
export type { SharingApi, SharingResult } from "./api";
export { DefaultsReview } from "./DefaultsReview";
export { SharingBoundary, type SharingEnv, SharingEnvProvider } from "./env";
export {
  ResourcePolicyEditor,
  type ResourcePolicyEditorProps,
} from "./ResourcePolicyEditor";
export { sharingItemPath } from "./route";
