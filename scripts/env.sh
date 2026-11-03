#!/bin/sh
# Source from the repository root. Toolchains remain isolated to this project.
export PATH="$PWD/.tools/node-v24.22.2-darwin-arm64/bin:$PWD/.tools/cargo/bin:$PWD/.tools/pnpm/node_modules/.bin:$PATH"
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export COREPACK_ENABLE_AUTO_PIN=0
export NEXT_TELEMETRY_DISABLED=1
