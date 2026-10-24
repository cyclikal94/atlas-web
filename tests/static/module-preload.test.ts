// @vitest-environment node
import { describe, expect, test } from "vitest";
import config from "../../vite.config";

/**
 * WEB-08c revision 2 (HF-11): a lazy chunk never preloads the ENTRY chunk (the page's own script, always already executed), which WebKit
 * reported as "preloaded using link preload but not used within a few seconds". Every other dependency is still preloaded.
 */
describe("build.modulePreload.resolveDependencies", () => {
  for (const mode of ["production", "fixture"]) {
    test(`${mode}: the entry is dropped, every other JS dependency and every CSS dependency kept`, () => {
      const resolved = (
        config as unknown as (env: { mode: string; command: string }) => {
          build: {
            modulePreload: {
              resolveDependencies: (
                filename: string,
                deps: string[],
                context: { hostId: string; hostType: "html" | "js" },
              ) => string[];
            };
          };
        }
      )({ mode, command: "build" });
      const resolve = resolved.build.modulePreload.resolveDependencies;
      const deps = [
        "assets/index-BbbXPvjT.js",
        "assets/fixture-BYIHYcmL.js",
        "assets/react-mkbhaBce.js",
        "assets/SwitchFlow-DOAQSaV1.js",
        "assets/index-CJV71mOo.css",
      ];
      expect(
        resolve("assets/sections-x.js", deps, {
          hostId: "assets/sections-x.js",
          hostType: "js",
        }),
      ).toEqual([
        "assets/react-mkbhaBce.js",
        "assets/SwitchFlow-DOAQSaV1.js",
        "assets/index-CJV71mOo.css",
      ]);
      // An HTML host keeps its list as built.
      expect(
        resolve("index.html", deps, { hostId: "index.html", hostType: "html" }),
      ).toEqual(deps);
    });
  }
});
