#!/usr/bin/env node
// Validates provenance.json: its shape, and that it agrees with contract-pin.json and the installed API-types package.
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "dist/_web/provenance.json";
const provenance = JSON.parse(readFileSync(file, "utf8"));
const pin = JSON.parse(readFileSync("contract-pin.json", "utf8"));
const installed = JSON.parse(
  readFileSync("node_modules/@atlas/api-types/provenance.json", "utf8"),
);
const errors = [];
const expect = (condition, message) => condition || errors.push(message);
const sha = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;

expect(
  commit.test(provenance.atlas_backend_ref?.commit ?? ""),
  "atlas_backend_ref.commit must be a full commit SHA",
);
expect(
  /^v\d+\.\d+\.\d+/.test(provenance.atlas_backend_ref?.tag ?? ""),
  "atlas_backend_ref.tag must be a version tag",
);
expect(
  sha.test(provenance.contract_hash ?? ""),
  "contract_hash must be a SHA-256",
);
expect(
  sha.test(provenance.api_types_tarball_sha256 ?? ""),
  "api_types_tarball_sha256 must be a SHA-256",
);
expect(
  typeof provenance.api_types_version === "string" &&
    provenance.api_types_version.length > 0,
  "api_types_version is required",
);
expect(
  provenance.frontend_ref &&
    (provenance.frontend_ref.commit === null ||
      commit.test(provenance.frontend_ref.commit)),
  "frontend_ref.commit must be a full commit SHA",
);
expect(
  typeof provenance.ci_run_id === "string" && provenance.ci_run_id.length > 0,
  "ci_run_id is required ('local' for a development build)",
);
expect(
  provenance.generation_inputs?.openapi_typescript,
  "generation_inputs.openapi_typescript is required",
);
expect(
  sha.test(provenance.generation_inputs?.generator_config_hash ?? ""),
  "generation_inputs.generator_config_hash must be a SHA-256",
);
expect(
  Array.isArray(provenance.tested_pairings),
  "tested_pairings must be a list (empty when no pairing was tested)",
);
if ("backend_image_digest" in provenance)
  expect(
    /^sha256:[0-9a-f]{64}$/.test(provenance.backend_image_digest),
    "backend_image_digest must be sha256:<hex>",
  );
if ("backend_native_checksum" in provenance)
  expect(
    sha.test(provenance.backend_native_checksum),
    "backend_native_checksum must be a SHA-256",
  );
expect(
  "backend_image_digest" in provenance ===
    provenance.tested_pairings.some((p) => p.kind === "image"),
  "backend_image_digest must be present exactly when an image pairing was tested",
);
expect(
  "backend_native_checksum" in provenance ===
    provenance.tested_pairings.some((p) => p.kind === "native"),
  "backend_native_checksum must be present exactly when a native pairing was tested",
);

// Agreement with the pin and with the installed package.
expect(
  provenance.atlas_backend_ref?.commit === pin.backend_commit,
  "backend commit differs from contract-pin.json",
);
expect(
  provenance.atlas_backend_ref?.tag === pin.backend_tag,
  "backend tag differs from contract-pin.json",
);
expect(
  provenance.contract_hash === pin.contract_sha256,
  "contract hash differs from contract-pin.json",
);
expect(
  provenance.api_types_tarball_sha256 === pin.tarball_sha256,
  "tarball hash differs from contract-pin.json",
);
expect(
  provenance.contract_hash === installed.contract_sha256,
  "contract hash differs from the installed @atlas/api-types",
);
expect(
  provenance.atlas_backend_ref?.commit === installed.backend_commit,
  "backend commit differs from the installed @atlas/api-types",
);
expect(
  provenance.generation_inputs?.generator_config_hash ===
    installed.generator_lock_sha256,
  "generator lock hash differs from the installed @atlas/api-types",
);

if (errors.length > 0) {
  console.error(`${file} is invalid:\n - ${errors.join("\n - ")}`);
  process.exit(1);
}
console.log(
  `${file} is valid and agrees with contract-pin.json and the installed @atlas/api-types.`,
);
