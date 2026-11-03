#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'This isolated bootstrap is for Apple Silicon macOS. See docs/operations/development.md.' >&2
  exit 1
fi
mkdir -p .tools/downloads
if [ ! -x .tools/node-v24.22.2-darwin-arm64/bin/node ]; then
  curl -fL --retry 2 -o .tools/downloads/node.tar.gz https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz
  curl -fL --retry 2 -o .tools/downloads/SHASUMS256.txt https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
  expected=$(awk '$2 == "node-v24.22.2-darwin-arm64.tar.gz" {print $1}' .tools/downloads/SHASUMS256.txt)
  actual=$(shasum -a 256 .tools/downloads/node.tar.gz | awk '{print $1}')
  test -n "$expected" && test "$actual" = "$expected"
  tar -xzf .tools/downloads/node.tar.gz -C .tools
fi
. ./scripts/env.sh
if [ ! -x .tools/pnpm/node_modules/.bin/pnpm ]; then
  npm install --prefix .tools/pnpm --ignore-scripts --no-audit --no-fund pnpm@10.33.4
fi
if [ ! -x .tools/cargo/bin/rustup ]; then
  curl -fL --retry 2 -o .tools/downloads/rustup-init https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init
  curl -fL --retry 2 -o .tools/downloads/rustup-init.sha256 https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init.sha256
  expected=$(awk '{print $1}' .tools/downloads/rustup-init.sha256)
  actual=$(shasum -a 256 .tools/downloads/rustup-init | awk '{print $1}')
  test "$actual" = "$expected"
  chmod +x .tools/downloads/rustup-init
  .tools/downloads/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.99.1 --component rustfmt --component clippy
fi
node --version
pnpm --version
rustc --version
printf '\nToolchains are project-local. Run: source scripts/env.sh\n'
