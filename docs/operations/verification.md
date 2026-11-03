# Phase 1 verification report

Verified locally on 3 November 2026, Apple Silicon macOS 26.6.2. No real World of Warcraft installation was read or modified.

## Installed project-local toolchains

- Node.js 24.22.2, pnpm 10.33.4, Rust/Cargo 1.99.1.
- Rustfmt and Clippy installed under `.tools/` with no shell-profile changes.
- Existing Xcode Command Line Tools, Clang 21.0.0 and macOS SDK 26.5 used.
- Embedded SQLite runtime: **3.53.4**, independent of the Apple SQLite CLI.
- Checksum-verified Compose CLI 5.7.0 stored under `.tools/`; no Docker Engine installed.

## Passing checks

| Check                                              | Result                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Frozen pnpm installation                           | Passed                                                                                             |
| Prettier formatting                                | Passed                                                                                             |
| ESLint, zero warnings                              | Passed                                                                                             |
| Strict package and tooling TypeScript checks       | Passed                                                                                             |
| Vitest                                             | **36 tests passed** across protocol, demo model, migrations and API                                |
| Dedicated migration suite                          | **5 tests passed**, including reopen, constraints, profile isolation and immutable snapshots       |
| Rust workspace tests                               | **2 conformance tests passed**, each consuming shared fixture vectors                              |
| Rustfmt and Clippy with warnings denied            | Passed                                                                                             |
| Playwright Chromium                                | **48 tests passed** across 1440px web, 1180px desktop browser shell, 768px tablet and 390px mobile |
| Automated accessibility                            | No findings in all eight views and the conflict-resolution dialog for tested WCAG tags             |
| Drizzle migration consistency check                | Passed                                                                                             |
| Full dependency audit, including development tools | No known vulnerabilities after patched pins/overrides                                              |
| Next.js production build                           | Passed                                                                                             |
| Vite desktop frontend build                        | Passed; approximately **99 KB gzip JavaScript**                                                    |
| Fastify production TypeScript build/start          | Passed; real readiness/capability responses verified                                               |
| Production web start/render/hydration              | All eight routes passed, zero browser page errors                                                  |
| Tauri native macOS debug bundle                    | Built successfully; **29.75 MiB** app bundle                                                       |
| Native UI inspection                               | Overview, devices, application metadata and diff inspected in the actual macOS app                 |
| Native capability                                  | `get_app_info` verified; no filesystem/shell/process plugin exposed                                |
| Compose configuration                              | Standalone CLI `config --quiet` passed                                                             |
| Bootstrap and shell syntax                         | Idempotent bootstrap and shell syntax checks passed                                                |

The native `.app` is at `target/debug/bundle/macos/Attuner.app`. The web and API production checks used alternate loopback ports 3001/4318 to avoid the development servers. Normal launch ports remain 3000/4317.

## Visual review and corrections

Reviewed actual rendered web, mobile and native views. Increased small supporting text, corrected native button appearance, stabilized profile identity, fixed screen-reader labels escaping table scroll containment, made comparison/inventory scrolling keyboard-accessible, and ensured scenario controls wait for hydration. Both OS reduced motion and the preview preference are supported. Unified comparison interleaves removed/added lines in context.

The screenshot artifacts in `artifacts/` include native macOS overview/diff, web overview/diff/conflict and a mobile overview. Native screenshots were captured from the running packaged application. `desktop-browser-overview.png` is explicitly a browser rendering of the desktop shell.

## Scope and limitations

All synchronization/profile/device/addon/activity/snapshot data in the UI is fictional. Progress and conflict resolution mutate memory only. Pairing and restore are informational previews, and unavailable API mutations return 501. Real synchronization, authentication, SSE, backup/application logic, game monitoring, tray and credentials are future phases.

The automated browser suite uses Chromium. Actual macOS WKWebView was inspected separately; this is not a full Safari or Windows native automation matrix. CI is configured but has not run on GitHub. Windows native execution, Docker image build/run, installer signing/notarization, cross-version OS compatibility and production deployment remain unverified. The application is a local debug build, not a production release.

Two upstream deprecated Drizzle Kit loader packages remain development-only dependencies; the relevant esbuild is overridden to a patched version and migration tooling was verified. Scoped minimatch overrides and the Vitest upgrade are documented in architecture decisions. Dependency audit results are point-in-time evidence, not a security guarantee.

## Recommended Phase 2

Implement a fixture-only Rust engine in small verified steps: installation adapter/coverage model, streaming BLAKE3 scans, stable manifests, three-way change planning, local SQLite metadata, Zstandard preimage backups, same-volume staging and journaled application/recovery in temporary directories. Fault-inject every interruption boundary. Keep the real-client adapter and external-launch interlock as explicit gates for later integration.
