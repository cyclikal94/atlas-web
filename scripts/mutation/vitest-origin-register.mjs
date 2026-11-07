// WEB-14a revision 29 (review r28 R31, design assessment C3): the `--import` of every supervised Vitest worker
// (vitest-supervised.mjs adds it to each project's execArgv). It registers the loading hook before the worker imports Vitest.
import { register } from "node:module";

register(new URL("./vitest-origin-loader.mjs", import.meta.url));
