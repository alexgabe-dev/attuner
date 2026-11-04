$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$attunerRoot = Split-Path $PSScriptRoot -Parent
Set-Location $attunerRoot
if ($env:OS -ne 'Windows_NT') { throw 'Package on the Windows CI runner only.' }
$attunerCommit = (git rev-parse HEAD).Trim()
$attunerOutput = Join-Path $attunerRoot ('artifacts/windows-qualification-' + $attunerCommit.Substring(0, 12))
if (Test-Path $attunerOutput) { throw 'Refusing to overwrite an existing qualification bundle.' }
New-Item -ItemType Directory -Path $attunerOutput | Out-Null
& cargo build -p attuner-platform-windows --bin attuner-qualify-windows --locked
if ($LASTEXITCODE -ne 0) { throw 'Native qualification driver compilation failed.' }
Copy-Item -LiteralPath (Join-Path $attunerRoot 'target/debug/attuner-qualify-windows.exe') -Destination (Join-Path $attunerOutput 'Qualify-Windows.exe')
$attunerTargets = @(
    @{ Package = 'attuner-platform-windows'; Target = 'handle_safety'; Kind = '--test'; File = 'handle-safety.exe' },
    @{ Package = 'attuner-platform-windows'; Target = 'attuner_platform_windows'; Kind = '--lib'; File = 'native-recovery.exe' },
    @{ Package = 'attuner-sync-core'; Target = 'windows_qualification'; Kind = '--test'; File = 'ntfs-probes.exe' },
    @{ Package = 'attuner-sync-core'; Target = 'attuner_sync_core'; Kind = '--lib'; File = 'protocol-tests.exe' },
    @{ Package = 'attuner-sync-client'; Target = 'attuner_sync_client'; Kind = '--lib'; File = 'credential-tests.exe' }
)
foreach ($attunerTarget in $attunerTargets) {
    $attunerArguments = @('test', '-p', $attunerTarget.Package, '--locked', '--no-run', '--message-format=json', $attunerTarget.Kind)
    if ($attunerTarget.Kind -eq '--test') { $attunerArguments += $attunerTarget.Target }
    $attunerMessages = & cargo @attunerArguments
    if ($LASTEXITCODE -ne 0) { throw 'Qualification test binary compilation failed.' }
    $attunerArtifact = @($attunerMessages | Where-Object { $_.StartsWith('{') } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq $attunerTarget.Target -and $_.profile.test -and $_.executable })
    if ($attunerArtifact.Count -ne 1) { throw 'Expected exactly one compiled qualification executable.' }
    Copy-Item -LiteralPath $attunerArtifact[0].executable -Destination (Join-Path $attunerOutput $attunerTarget.File)
}
Copy-Item -LiteralPath (Join-Path $attunerRoot 'target/debug/attuner-desktop.exe') -Destination (Join-Path $attunerOutput 'Attuner.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'qualify-windows.ps1') -Destination (Join-Path $attunerOutput 'Qualify-Windows.ps1')
Copy-Item -LiteralPath (Join-Path $attunerRoot 'docs/operations/windows-11-qualification.md') -Destination (Join-Path $attunerOutput 'README.md')
$attunerFiles = @(Get-ChildItem -LiteralPath $attunerOutput -File | Sort-Object Name | ForEach-Object { @{ name = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
@{ schemaVersion = 4; sourceCommit = $attunerCommit; target = 'x86_64-pc-windows-msvc'; rust = (& rustc --version); files = $attunerFiles; filesystemApplyEnabled = $false; scope = 'synthetic_native_recovery'; signed = $false } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $attunerOutput 'manifest.json') -Encoding UTF8
Write-Output $attunerOutput
