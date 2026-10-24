import { gitState } from "./lib/git.mjs";

const state = gitState();
if (!state.commit) throw new Error("Source has no verified Git revision");
console.log(state.commit);
