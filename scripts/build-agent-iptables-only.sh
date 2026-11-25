#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/agent"
VERSION="$(tr -d '\r\n' < "$ROOT_DIR/agent/IPTABLES_ONLY_VERSION")"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Invalid standalone Agent version' >&2; exit 1
fi
command -v go >/dev/null || { echo 'Go >=1.23 is required' >&2; exit 1; }
# The protocol capability version remains the standard Agent version; only the
# standalone package version is independent of the panel's update indicator.
STANDARD_VERSION="$(sed -nE 's/.*AGENT_VERSION[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$ROOT_DIR/shared/versions.ts" | head -n 1)"
[ -n "$STANDARD_VERSION" ] || { echo 'Cannot read standard Agent protocol version' >&2; exit 1; }
mkdir -p "$OUT_DIR"
for arch in amd64 arm64; do
  package_dir="$(mktemp -d)"
  (
    cd "$ROOT_DIR/agent"
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" \
      go build -tags iptablesonly -trimpath -ldflags "-s -w -X main.Version=$STANDARD_VERSION -X main.iptablesOnlyVersion=$VERSION" -o "$package_dir/forwardx-agent" .
  )
  install -m 0755 "$ROOT_DIR/scripts/install-agent-iptables-only.sh" "$package_dir/install.sh"
  install -m 0755 "$ROOT_DIR/scripts/forwardx-iptables-menu.sh" "$package_dir/forwardx-menu"
  printf '%s\n' "$VERSION" > "$package_dir/VERSION"
  tar -C "$package_dir" -czf "$OUT_DIR/forwardx-agent-iptables-only-v$VERSION-linux-$arch.tar.gz" forwardx-agent install.sh forwardx-menu VERSION
  rm -rf "$package_dir"
done
(cd "$OUT_DIR" && sha256sum "forwardx-agent-iptables-only-v$VERSION-linux-"*.tar.gz > "iptables-only-v$VERSION-SHA256SUMS")
