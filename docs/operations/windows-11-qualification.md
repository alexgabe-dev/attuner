# Standalone Windows 11 qualification

No runner, Rust compiler, Node installation or administrator shell is required for this bundle. It contains the Windows-native prerequisite probes, protocol tests, a Credential Manager round-trip and a portable debug desktop app. Every filesystem test mints its own synthetic temporary directory. Nothing searches for or opens a WoW installation.

Windows filesystem apply is deliberately disabled. Passing these probes is **prerequisite evidence**, not completed Windows recovery qualification. Do not power-cycle your physical PC for this stage.

## Download and run

1. In the Attuner GitHub repository, open **Actions → Attuner verification**, choose a successful run on `phase3-secure-sync`, and download **attuner-windows-qualification**. Check its source commit against `manifest.json` after extracting the ZIP into a new local folder, for example `Documents\AttunerQualification`.
2. Open a normal PowerShell window in the extracted folder. The script verifies every bundled file against the manifest before executing anything. Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Qualify-Windows.ps1
```

`ExecutionPolicy Bypass` applies only to this process; it does not change machine policy. The script creates `results\<timestamp>\report.json` and individual logs beside the extracted files. It never deletes your existing files. The credential test creates and removes only its own random `app.attuner.desktop.tests` entry.

The report records Windows edition/build, architecture, source commit and test exit codes. It intentionally leaves application recovery and desktop visual review unqualified. ARM64 running the x64 bundle is compatibility evidence only; native ARM64 qualification remains separate.

## Desktop review

After the scripts pass, launch the portable app:

```powershell
Start-Process .\Attuner.exe
```

It is an unsigned development build, not an installer or production release. If Windows requests publisher confirmation, verify the downloaded source/run and checksums first; do not disable antivirus or machine security settings. The app uses WebView2. Windows 11 normally includes that runtime; a missing-runtime message is a prerequisite to report, not permission for these scripts to install system software. See Microsoft's [WebView2 distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

Record screenshots at 100%, 125% and 150% display scaling: window controls, sidebar, profile menu, tables, dialogs, focus rings and narrow-window behavior. Use keyboard navigation and check long device/file names. Confirm the Windows filesystem qualification gate is visible and fixture/apply actions are disabled where unsupported. Do not select a game directory; no installation picker should exist.

The connection screen must explain that Windows file operations await durability qualification. After enrollment, remote devices, revisions, activity, comparisons and proposals are real; local fixture/apply actions remain disabled. Use a synthetic development account/profile only. Do not paste credentials into logs or the report.

For an optional connected check against an already configured private SSH host running the loopback development services, open another normal PowerShell window and keep this tunnel running:

```powershell
ssh -N -L 4318:127.0.0.1:4318 <your-mac-user>@<your-private-mac-host>
```

Do not enable SSH or change firewall settings solely through these scripts. If an existing private connection is unavailable, complete the standalone probes and offline UI review first. The macOS service launch commands are in [Phase 3 development](phase-3-development.md). Use `https://127.0.0.1:4318` on the Windows PC. Copy only the public `.runtime/dashboard-ca.pem`, verify its SHA-256 against the macOS copy, and paste that public certificate into Attuner’s custom CA field:

```powershell
Get-FileHash .\dashboard-ca.pem -Algorithm SHA256
```

Create a synthetic profile in the HTTPS web dashboard, choose **Connect device** in the portable app, approve only that profile’s permissions in the browser, and return to Attuner. Verify Credential Manager reconnect using the same binary, remote navigation/filters, immutable revision comparison, conflict proposal review, and revocation. Any browser certificate warning requires a deliberate local owner decision; the qualification scripts do not bypass it or install a trusted root. Never enable Windows file application to complete a UI check.

## Evidence to return

Return `report.json`, the three test logs, screenshots and any reproduction steps. Review those files before sharing; they contain no account tokens, but an operating-system error can include your local temporary path. Report missing WebView2, application launch failure, antivirus interference or unexpected prompts rather than changing system policy.

The remaining write/apply qualification requires a reviewed Windows-native journal/durability implementation, its complete interruption/recovery suite and controlled retained-disk reset testing. A physical-PC reboot is not a substitute for a controlled fault environment. Until that gate is closed, Attuner must continue to refuse Windows filesystem application.
