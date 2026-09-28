# Atlas Web

Independent, offline-capable web client for Atlas. The bootstrap provides the
build/test foundation; application features follow the approved delivery plan.

See [CONTRIBUTING.md](CONTRIBUTING.md) for installation, commands and scope.
`pnpm dev` opens the neutral entry. The production build contains a compiled
Workbox worker; registration and update UX belong to WEB-14a.

API types are vendored from the backend GitHub release identified in
`contract-pin.json`. `contract-release-verification.json` records the verified
release asset, tag commit, contract and checksums. Frontend builds consume that
package without reading a backend checkout. This scaffold is not yet a frontend
release or deployment.
