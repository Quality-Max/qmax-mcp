#!/bin/sh
set -eu

package='@qualitymax/qmax-mcp'
minimum_node='22.13.0'

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "qmax requires Node.js ${minimum_node} or newer." >&2
  printf '%s\n' 'Install Node.js from https://nodejs.org/ and run this command again.' >&2
  exit 1
fi

if ! node -e '
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0))) ? 0 : 1);
'; then
  printf '%s\n' "qmax requires Node.js ${minimum_node} or newer; found $(node --version)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'qmax requires npm, but npm was not found.' >&2
  exit 1
fi

printf '%s\n' "Installing ${package}..."
npm install --global "${package}"
printf '%s\n' 'qmax installed. Run `qmax-mcp --help` to get started.'
