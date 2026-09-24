# Atlas Web

Independent, offline-capable web client for Atlas. This initial bootstrap is ready
for review; application features follow the approved delivery plan.

See [CONTRIBUTING.md](CONTRIBUTING.md) for installation, commands and scope.
`pnpm dev` opens the neutral entry. The production build contains a compiled
Workbox worker; registration and update UX belong to WEB-14a.

The local API types tarball is generated from the recorded backend commit and
checksum-verified. It is explicitly a bootstrap asset pending the backend release
pipeline and published pin. No deployment or release is implied by this scaffold.
