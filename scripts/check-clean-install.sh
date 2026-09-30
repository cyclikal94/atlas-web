#!/usr/bin/env bash
# C8. Copies the repository WITHOUT node_modules, build output, agent state and any sibling checkout into a scratch directory, installs from the
# lockfile and the pinned tarball only, then type-checks, builds and prepares provenance. It fails loudly if anything depends on
# something that is not in package.json, the lockfile or the vendored contract package. The scratch copy is removed on exit.
set -euo pipefail
cd "$(dirname "$0")/.."
EVIDENCE=".agtx/evidence/WEB-07/C8"
mkdir -p "$EVIDENCE"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atlas-web-clean.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

rsync -a --exclude node_modules --exclude dist --exclude dist-fixture --exclude release --exclude test-results \
  --exclude playwright-report --exclude .agtx --exclude .agents --exclude .claude --exclude .codex --exclude .mcp.json --exclude .git ./ "$TMP/repo/"
cd "$TMP/repo"
[ ! -e node_modules ] || { echo "the scratch copy has node_modules" >&2; exit 1; }
{
  echo "node $(node -v), pnpm $(pnpm -v)"
  pnpm install --frozen-lockfile
  pnpm check:contract
  pnpm typecheck
  pnpm build
  pnpm build:fixture
  git init -q . >/dev/null 2>&1 || true
  pnpm package:prepare
  node scripts/check-no-fixture.mjs dist
  node scripts/check-external-urls.mjs dist
  node scripts/check-notices.mjs dist
} 2>&1 | tee "$OLDPWD/$EVIDENCE/clean-install.log" | tail -25
echo "Clean install ok: resolved from package.json, the lockfile and the vendored contract package only."
