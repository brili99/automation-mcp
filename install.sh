#!/bin/sh
set -eu

MIN_BUN_VERSION="1.4.2"
PACKAGE_NAME="local-agent-automation-mcp"
BIN_NAME="automation-mcp"

fail() {
  printf 'automation-mcp installer: %s\n' "$1" >&2
  exit 1
}

version_at_least() {
  awk -v actual="$1" -v minimum="$2" 'BEGIN {
    split(actual, a, "."); split(minimum, b, ".");
    for (i = 1; i <= 3; i++) {
      av = a[i] + 0; bv = b[i] + 0;
      if (av > bv) exit 0;
      if (av < bv) exit 1;
    }
    exit 0;
  }'
}

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) fail "supported operating systems are Linux and macOS." ;;
esac
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) fail "unsupported CPU architecture: $(uname -m)." ;;
esac

if ! command -v curl >/dev/null 2>&1; then fail "curl is required to download Bun."; fi
if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version 2>/dev/null || true)"
  if ! version_at_least "$BUN_VERSION" "$MIN_BUN_VERSION"; then
    printf 'Bun %s is older than required %s; installing the tested minimum into ~/.bun.\n' "$BUN_VERSION" "$MIN_BUN_VERSION" >&2
    curl -fsSL https://bun.sh/install | bash -s "bun-v${MIN_BUN_VERSION}"
  fi
else
  curl -fsSL https://bun.sh/install | bash -s "bun-v${MIN_BUN_VERSION}"
fi

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
command -v bun >/dev/null 2>&1 || fail "Bun installed but is not on PATH. Add ~/.bun/bin to PATH and rerun."
BUN_VERSION="$(bun --version 2>/dev/null || true)"
version_at_least "$BUN_VERSION" "$MIN_BUN_VERSION" || fail "Bun $MIN_BUN_VERSION or newer is required; found '$BUN_VERSION'."

bun add --global "$PACKAGE_NAME" || fail "global package installation failed. Check your network and Bun global package configuration."
command -v "$BIN_NAME" >/dev/null 2>&1 || {
  printf 'Installed, but %s is not on PATH. Add Bun global bin (~/.bun/bin) to PATH.\n' "$BIN_NAME" >&2
  exit 1
}
"$BIN_NAME" --help >/dev/null || fail "installed CLI verification failed."
printf 'Installed %s.\n' "$BIN_NAME"