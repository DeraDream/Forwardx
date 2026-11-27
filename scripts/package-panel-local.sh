#!/usr/bin/env bash
# Package only the Panel/System runtime. Never archive dist/ wholesale: local
# OCI images, build logs and previous releases may also live there.
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:-$(node -p "require('./package.json').version")}"; version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid Panel version: $version" >&2; exit 1; }
output="dist/panel/forwardx-panel-v${version}.tar.gz"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"; rm -f "${output}.tmp"' EXIT

test -s dist/index.js
test -s client/dist/index.html
for arch in amd64 arm64; do
  for name in "forwardx-agent-linux-$arch" "forwardx-fxp-linux-$arch" "forwardx-runtime-linux-$arch"; do
    test -s "dist/agent/$name" || { echo "Missing bundled runtime: $name" >&2; exit 1; }
  done
  test -s "dist/sublinkx/sublink-linux-$arch"
done
(cd dist/agent && sha256sum -c SHA256SUMS)

t0=$(date +%s%N)
mkdir -p "$stage/dist/agent" "$stage/dist/sublinkx" dist/panel
for name in index migrate-legacy reset-admin-password; do
  test -s "dist/$name.js"
  cp -a "dist/$name.js" "dist/$name.js.map" "$stage/dist/"
done
cp -a dist/agent/SHA256SUMS dist/agent/THIRD_PARTY_NOTICES.md "$stage/dist/agent/"
for arch in amd64 arm64; do
  cp -a "dist/agent/forwardx-agent-linux-$arch" "dist/agent/forwardx-fxp-linux-$arch" \
    "dist/agent/forwardx-runtime-linux-$arch" "$stage/dist/agent/"
done
cp -a dist/sublinkx/sublink-linux-* "$stage/dist/sublinkx/"
cp -a drizzle patches package.json pnpm-lock.yaml pnpm-workspace.yaml "$stage/"
# Build output only; do not copy the source tree or node_modules.
mkdir -p "$stage/client"
cp -a client/dist "$stage/client/"
mkdir -p "$stage/scripts" "$stage/services/sublinkx"
cp -a scripts/install-panel-local.sh scripts/install-panel-docker.sh scripts/migrate-agent-legacy.sh "$stage/scripts/"
cp -a services/sublinkx/LICENSE "$stage/services/sublinkx/"
echo "[Panel package] stage=$(( ($(date +%s%N) - t0) / 1000000 ))ms"

t0=$(date +%s%N)
# -1 trades a small amount of bundle size for faster single-core compression.
# Atomic rename prevents a failed packaging run from leaving a partial asset.
tar --sort=name -C "$stage" -cf - \
  dist client/dist drizzle patches package.json pnpm-lock.yaml pnpm-workspace.yaml \
  scripts/install-panel-local.sh scripts/install-panel-docker.sh scripts/migrate-agent-legacy.sh \
  services/sublinkx/LICENSE | gzip -1 > "${output}.tmp"
mv "${output}.tmp" "$output"
echo "[Panel package] compress=$(( ($(date +%s%N) - t0) / 1000000 ))ms output=$output"
ls -lh "$output"
