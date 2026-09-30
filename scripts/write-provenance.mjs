#!/usr/bin/env node
// Writes provenance.json for the build in dist/, in the shape of provenance.json.example. Never rebuilds anything.
// Every artefact (archive, image, chart) carries this one file, so they can be shown to be the same build.
//
// backend_image_digest and backend_native_checksum are recorded only for pairings that were actually tested, and are
// passed explicitly (--tested-native, --tested-image). Otherwise they are omitted and tested_pairings is empty: the
// frontend never claims compatibility it has not shown.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gitState } from "./lib/git.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = option("out") ?? "dist/_web/provenance.json";

const pin = JSON.parse(readFileSync("contract-pin.json", "utf8"));
const installed = JSON.parse(
  readFileSync("node_modules/@atlas/api-types/provenance.json", "utf8"),
);
const git = gitState();
const generator =
  /^openapi-typescript@(.+)$/.exec(pin.generator)?.[1] ?? pin.generator;

const provenance = {
  atlas_backend_ref: { tag: pin.backend_tag, commit: pin.backend_commit },
  contract_hash: pin.contract_sha256,
  api_types_version: pin.version,
  api_types_tarball_sha256: pin.tarball_sha256,
  frontend_ref: { tag: git.tag, commit: git.commit, dirty: git.dirty },
  ci_run_id:
    process.env.GITHUB_RUN_ID ?? process.env.ATLAS_CI_RUN_ID ?? "local",
  generation_inputs: {
    openapi_typescript: generator,
    generator_config_hash: installed.generator_lock_sha256,
  },
  tested_pairings: [],
};
const native = option("tested-native");
const image = option("tested-image");
if (native) {
  provenance.backend_native_checksum = native;
  provenance.tested_pairings.push({ kind: "native", checksum: native });
}
if (image) {
  provenance.backend_image_digest = image;
  provenance.tested_pairings.push({ kind: "image", digest: image });
}

mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(out, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(
  `Wrote ${out} (backend ${pin.backend_tag}, frontend ${git.commit?.slice(0, 12) ?? "unknown"}${git.dirty ? "+dirty" : ""}).`,
);
