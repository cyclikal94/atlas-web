import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const pin = JSON.parse(
  readFileSync(new URL("../contract-pin.json", import.meta.url)),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asset = new URL(`../${pin.local_asset}`, import.meta.url);
if (sha256(readFileSync(asset)) !== pin.tarball_sha256)
  throw Error("API tarball checksum mismatch");
const schema = readFileSync(
  new URL("../node_modules/@atlas/api-types/openapi.json", import.meta.url),
);
if (sha256(schema) !== pin.contract_sha256)
  throw Error("Installed API contract differs from pin");
const pkg = JSON.parse(
  readFileSync(
    new URL("../node_modules/@atlas/api-types/package.json", import.meta.url),
  ),
);
const provenance = JSON.parse(
  readFileSync(
    new URL(
      "../node_modules/@atlas/api-types/provenance.json",
      import.meta.url,
    ),
  ),
);
if (
  pkg.version !== pin.version ||
  provenance.backend_commit !== pin.backend_commit ||
  provenance.contract_sha256 !== pin.contract_sha256
)
  throw Error("Installed API provenance differs from pin");
if (
  process.argv.includes("--require-release") &&
  (pin.status !== "released" ||
    !/^https:\/\//.test(pin.release_url ?? "") ||
    !pin.backend_tag ||
    pin.version !== pin.backend_tag.replace(/^v/, ""))
)
  throw Error(
    "A published, pinned backend API-types release is required before task worktrees/production delivery",
  );
if (process.argv.includes("--require-release")) {
  const verified = JSON.parse(
    readFileSync(
      new URL("../contract-release-verification.json", import.meta.url),
    ),
  );
  if (
    verified.verified_by !== "github-api-and-release-download" ||
    verified.pin_sha256 !==
      sha256(readFileSync(new URL("../contract-pin.json", import.meta.url))) ||
    verified.tarball_sha256 !== pin.tarball_sha256 ||
    verified.backend_commit !== pin.backend_commit ||
    !verified.release_id ||
    !verified.asset_id
  )
    throw Error("Published asset and tag have not been verified");
}
console.log(`Verified @atlas/api-types ${pin.version} (${pin.status})`);
