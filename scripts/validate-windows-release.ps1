param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or [string]::IsNullOrWhiteSpace($env:ATTUNER_WINDOWS_PUBLISHER)) { throw 'Windows and an expected publisher are required.' }
$attunerSignTool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $attunerSignTool) { throw 'Windows SDK SignTool is required for validation.' }
foreach ($attunerName in @('Attuner.exe', 'Attuner-setup.exe')) {
    $attunerPath = Join-Path $Directory $attunerName
    $attunerSignature = Get-AuthenticodeSignature -LiteralPath $attunerPath
    if ($attunerSignature.Status -ne 'Valid' -or $attunerSignature.SignerCertificate.Subject -cne $env:ATTUNER_WINDOWS_PUBLISHER -or -not $attunerSignature.TimeStamperCertificate) { throw ('Invalid publisher, signature or timestamp: ' + $attunerName) }
    & $attunerSignTool.FullName verify /pa /all /tw /v $attunerPath
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode verification failed.' }
}
if ([string]::IsNullOrWhiteSpace($env:ATTUNER_SIGNING_RECEIPTS)) { throw 'Bundler signing receipts are required.' }
$attunerReceipts = @(Get-Content -LiteralPath $env:ATTUNER_SIGNING_RECEIPTS | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ | ConvertFrom-Json })
if (-not ($attunerReceipts | Where-Object { $_.name -match 'uninstall' -and $_.publisherVerified -and $_.timestampVerified })) { throw 'No verified signed uninstaller receipt.' }
$attunerReceipts | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Directory 'signing-receipts.json') -Encoding UTF8
@{ schemaVersion = 1; platform = 'windows'; applicationIdentity = 'app.attuner.desktop'; signatureVerified = $true; timestampVerified = $true; uninstallerSignatureVerified = $true; publisher = $env:ATTUNER_WINDOWS_PUBLISHER } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'validation.json') -Encoding UTF8
