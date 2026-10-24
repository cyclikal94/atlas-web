/**
 * Settings path segments that code outside the Settings screens names. The registry (`sections.ts`) uses the same constants, so the two
 * cannot drift; a test holds them equal.
 *
 * WEB-08c revision 12: this is a module of its own because the registry imports every section's route builder, including the
 * calendar section's lazy screen. `lifecycle-wiring` (a lazy chunk) importing the registry made the bundler split the fixture's shared
 * shell out of its entry into eleven further initial files (+7.8 KB gzip, `.agtx/evidence/WEB-08c/revision-12/budget`).
 */
export const SESSIONS_SECTION_ROUTE = "sessions";

/**
 * The link target of a Settings section. Its routes are built at run time (see `settingsRoute`), so the typed router does not know them;
 * this is the one place that says so.
 */
export const settingsPath = (route: string): "/settings" =>
  `/settings/${route}` as "/settings";
