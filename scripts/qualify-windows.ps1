param([switch]$AllowServer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This qualification runs on Windows only.' }
$attunerOS = Get-CimInstance Win32_OperatingSystem
if (-not $AllowServer -and ($attunerOS.ProductType -ne 1 -or [int]$attunerOS.BuildNumber -lt 22000)) { throw 'Windows 11 is required. Server CI uses the explicit -AllowServer option.' }
$attunerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$attunerPrincipal = New-Object Security.Principal.WindowsPrincipal($attunerIdentity)
if (-not $AllowServer -and $attunerPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from a normal, non-administrator PowerShell window.' }
$attunerManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($attunerManifest.schemaVersion -ne 1 -or $attunerManifest.filesystemApplyEnabled) { throw 'Unsupported qualification bundle or unexpected filesystem mutation gate.' }
foreach ($attunerFile in $attunerManifest.files) {
    if ([IO.Path]::GetFileName($attunerFile.name) -ne $attunerFile.name -or $attunerFile.name.Contains(':') -or $attunerFile.name.StartsWith('.')) { throw 'Unsafe bundle manifest entry.' }
    $attunerHash = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $attunerFile.name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($attunerHash -ne $attunerFile.sha256) { throw ('Bundle checksum failed: ' + $attunerFile.name) }
}
$attunerResults = Join-Path $PSScriptRoot ('results/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $attunerResults | Out-Null
$attunerReport = [ordered]@{
    schemaVersion = 1; sourceCommit = $attunerManifest.sourceCommit; os = $attunerOS.Caption; build = $attunerOS.BuildNumber
    architecture = $env:PROCESSOR_ARCHITECTURE; bundleTarget = $attunerManifest.target; windows11 = ($attunerOS.ProductType -eq 1 -and [int]$attunerOS.BuildNumber -ge 22000)
    tests = @(); qualification = 'prerequisites_only'; filesystemApplyEnabled = $false
    applicationRecoveryQualified = $false; desktopVisualReview = 'pending_manual_review'; realInstallationsAccessed = $false
}
$attunerFailed = $false
try {
    foreach ($attunerTest in @('ntfs-probes.exe', 'protocol-tests.exe', 'credential-tests.exe')) {
        $attunerLog = Join-Path $attunerResults ($attunerTest + '.log')
        & (Join-Path $PSScriptRoot $attunerTest) --test-threads=1 2>&1 | Tee-Object -FilePath $attunerLog
        $attunerCode = $LASTEXITCODE
        $attunerReport.tests += @{ executable = $attunerTest; exitCode = $attunerCode; passed = ($attunerCode -eq 0) }
        if ($attunerCode -ne 0) { $attunerFailed = $true }
    }
} finally {
    $attunerReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $attunerResults 'report.json') -Encoding UTF8
}
Write-Output ('Results: ' + $attunerResults)
Write-Output 'These probes do not qualify filesystem application or recovery. Windows apply stays disabled.'
if ($attunerFailed) { exit 1 }
