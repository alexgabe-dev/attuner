# Local development

## Apple Silicon bootstrap

From the repository root:

```sh
sh scripts/bootstrap-macos.sh
source scripts/env.sh
pnpm install --frozen-lockfile
```

The bootstrap verifies official archive checksums and installs only under ignored `.tools/`. No sudo, system package manager or shell-profile changes. Existing Xcode Command Line Tools are required. Downloads need internet access. On other platforms, install Node 24.22.2, pnpm 10.33.4, Rust 1.99.1 plus platform Tauri prerequisites using your normal user-managed tooling.

## Launch

```sh
source scripts/env.sh
pnpm dev                 # Next.js :3000 and Fastify :4317
```

In a second terminal, from this repository:

```sh
source scripts/env.sh
pnpm dev:desktop         # native Tauri app; starts Vite :1420
```

Do not start `dev:desktop:browser` at the same time as `dev:desktop`: both own port 1420. A built app is independent of Vite and the API:

```sh
pnpm --filter @attuner/desktop tauri build --debug
open target/debug/bundle/macos/Attuner.app
```

Web-only: `pnpm dev:web`. Desktop browser fixture preview: `pnpm dev:desktop:browser`. API-only: `pnpm dev:api`. Runtime data is under ignored `.runtime/` at the repository root when using these package scripts. API configuration uses process environment, not an automatically loaded `.env` file.

## Check

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm db:migrate:test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Playwright starts/reuses loopback web/Vite servers and checks web 1440px, desktop browser shell 1180px, tablet 768px and mobile 390px. Native macOS inspection is separate from browser-shell automation. Test data is deterministic and has a fixed 3 November 2026 clock.

Production build checks:

```sh
pnpm --filter @attuner/api start
pnpm --filter @attuner/web start
```

## Infrastructure limits

Docker Engine is not installed by the project bootstrap. Development Compose publishes Nginx on 127.0.0.1:8080 only. Container builds/run require an installed runtime; installing a host VM/network helper must be separately authorized. Production TLS, backup automation, signing/notarization and public deployment belong to Phase 6.

## Debugging

`GET http://127.0.0.1:4317/api/v1/health/ready` reports the embedded SQLite version. Capabilities honestly report unavailable operations. Unknown mutations return 501. The UI is intentionally disconnected from this API and has no game-file access. Do not point fixtures or tests at an actual installation.

## Phase 2 local lab

In the native app choose **Overview → Local engine → Create fixture workspace**. Scan, capture and verify use actual Rust I/O in a private synthetic temporary directory; the web dashboard and Remote demo remain simulated. No arbitrary installation path or apply/restore command is exposed.

```sh
source scripts/env.sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build -p attuner-sync-core --example fixture_benchmark --release
/usr/bin/time -l target/release/examples/fixture_benchmark
```

See [verification and measurements](phase-2-verification.md) and [engine/recovery documentation](../architecture/local-engine.md). Native lab sessions are not reattached on restart; core reopening and recovery are covered by isolated tests. Windows durable operations remain disabled pending platform qualification. Never copy real game files into the lab.
