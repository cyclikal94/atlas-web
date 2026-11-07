/**
 * FIXTURE ONLY (WEB-14a P-R1). A lazy chunk nothing loads unless a spec asks (`window.__atlasFixture.session.lazyBuildLabel()`): it carries
 * the build's label, so every generation has its own copy under its own hashed name. An old tab that imports it after newer generations
 * replaced its files on the server proves that the worker kept the old tab's generation.
 */
export const label: string = import.meta.env.VITE_ATLAS_BUILD_LABEL ?? "";
