// The part of jsdom's API the display-recorder unit tests use (jsdom is the unit environment's own dependency and ships no types; adding
// `@types/jsdom` would change the lockfile for two calls).
declare module "jsdom" {
  export class JSDOM {
    constructor(
      html: string,
      options?: { url?: string; runScripts?: "outside-only" | "dangerously" },
    );
    readonly window: Window & typeof globalThis;
  }
}
