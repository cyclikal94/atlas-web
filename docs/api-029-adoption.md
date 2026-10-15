# API 0.29 contract adoption

The client targets the published Atlas API 0.29.0 contract, package v0.29.0-rc.1. `contract-pin.json` identifies the exact backend commit and downloaded archive; `contract-release-verification.json` binds the public release/tag, checksums and source verification. Health compatibility remains the existing strict rule: >=0.29.0 and <0.30.0. Existing lower/upper rejection and malformed-version checks remain.

API 0.29 adds viewer-safe People list/detail/field-audience reads and 17 schemas. Existing API paths and schemas are unchanged from the actual API 0.28 release. The backend's `docs/people.md` describes filtering, identity/epoch ownership, privacy, pagination, snapshot consistency and freshness obligations. WEB-11a owns the UI implementation and independent consumer review; importing types does not implement those journeys or grant frontend release acceptance.

Current fixture health responses, compatibility expectations, preview/packaging checks and optional PostgreSQL backend image follow the new pin. Existing partial session test doubles remain partial and do not prove People summaries or other unmodelled response fields. Historical 0.27/0.28 measurements and review reports retain their original attribution and do not become API 0.29 evidence.

Active tasks may retain their previously verified published pin while finishing a frozen campaign. Adopt accepted contract changes at an idle authoring boundary, preserving prior evidence and checking the applicable integration paths. The API-only adoption branch is based on the accepted common client baseline so held People work can consume it without an unrelated calendar merge; main also contains the separately accepted calendar feature.
