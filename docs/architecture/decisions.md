# Foundation decisions and scope adjustments

The Phase 0 architecture remains in force. No game discovery, file application, background synchronization, authentication or blob transfer is implemented in Phase 1.

- **Project-local toolchains:** Node 24.22.2, pnpm 10.33.4 and Rust 1.99.1 live in ignored `.tools/`. No shell profile, system package manager or administrator privileges are needed. Xcode Command Line Tools are already installed.
- **Demo composition:** the shared UI contains an explicitly named demonstration workbench driven by pure fixture models in `shared`. It has no API client. Later live controllers must adapt engine/API state into presentation models rather than reuse the demo reducer as synchronization logic.
- **Database worker sequencing:** Phase 1 uses one connection for startup migrations and the constant-time readiness query. The dedicated worker and runtime repository queue are deferred until Phase 3 introduces operational database work. UI processes never import the database package.
- **Database runtimes:** `better-sqlite3` embeds its own checked SQLite runtime. The system Apple SQLite CLI is not used. Rust local metadata and Zstandard dependencies begin in Phase 2; adding unused engine dependencies now would not validate those features.
- **Diff sequencing:** a bounded, syntax-highlighted fixture comparison demonstrates the layout and interactions without Monaco. Monaco, contextual retrieval, syntax parsing and real snapshot comparisons are Phase 5. No code evaluation is used.
- **Infrastructure:** development Compose/Nginx configuration is provided for loopback-only inspection. No TLS, public service or production deployment is configured. Docker runtime installation changes the host outside this project and is not necessary for native Phase 1; container execution requires a separately installed engine. A project-local Compose CLI can validate configuration without an engine.
- **Dependency hardening:** Vitest 5.1 replaces the vulnerable earlier test runner. Scoped pnpm overrides patch the Drizzle Kit loader’s esbuild and ESLint’s minimatch; migration generation, lint and tests must remain verified with these overrides.
- **Tooling:** ESLint 10 replaces the deprecated ESLint 9 line encountered during installation. TypeScript 5.9.3 remains pinned; lockfiles pin all resolved dependencies.
- **Native conventions:** use real OS titlebar controls, an original Attuner icon and a metadata-only native capability. Window-close/tray behavior, native credential storage and launch integration belong to Phase 4.
- **Deployment contracts:** device and web authentication remain separate designs. All mutations return 501 in this phase. The unauthenticated API has no read access to configuration contents and binds loopback unless explicitly configured for an isolated container network.

These are scoped implementation sequencing choices, not claims of completed synchronization or security features.
