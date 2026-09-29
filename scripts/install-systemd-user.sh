#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  printf 'systemd user service installation is supported on Linux only.\n' >&2
  exit 1
fi
if ! command -v automation-mcp >/dev/null 2>&1; then
  printf 'Install Bun and the automation-mcp CLI first, then rerun this installer.\n' >&2
  exit 1
fi
exec automation-mcp service install