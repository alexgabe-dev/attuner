param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT' -or $env:CI -ne 'true') { throw 'Cloud signing is restricted to the configured Windows CI job.' }
foreach ($attunerVariable in @('ATTUNER_SIGNING_ENDPOINT', 'ATTUNER_SIGNING_ACCOUNT', 'ATTUNER_SIGNING_PROFILE', 'ATTUNER_WINDOWS_PUBLISHER', 'ATTUNER_SIGNING_RECEIPTS')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($attunerVariable))) { throw ('Missing signing configuration: ' + $attunerVariable) }
}
$attunerFile = Get-Item -LiteralPath $File
if ($attunerFile.PSIsContainer -or ($attunerFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $attunerFile.Extension -notin @('.exe', '.dll', '.msi')) { throw 'Unsafe signing input.' }
# Installed by the pinned Azure action. Never import a floating module version.
Import-Module ArtifactSigning -RequiredVersion 0.1.8
Invoke-ArtifactSigning -Endpoint $env:ATTUNER_SIGNING_ENDPOINT -SigningAccountName $env:ATTUNER_SIGNING_ACCOUNT -CertificateProfileName $env:ATTUNER_SIGNING_PROFILE -Files @($attunerFile.FullName) -FileDigest SHA256 -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256 -ExcludeEnvironmentCredential $true -ExcludeManagedIdentityCredential $true -ExcludeAzureCliCredential $false -ExcludeInteractiveBrowserCredential $true
$attunerSignature = Get-AuthenticodeSignature -LiteralPath $attunerFile.FullName
if ($attunerSignature.Status -ne 'Valid' -or $attunerSignature.SignerCertificate.Subject -cne $env:ATTUNER_WINDOWS_PUBLISHER -or -not $attunerSignature.TimeStamperCertificate) { throw 'Cloud signing verification failed.' }
# Public evidence only; no credentials or absolute build paths in the artifact.
@{ name = $attunerFile.Name; sha256 = (Get-FileHash -LiteralPath $attunerFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); publisherVerified = $true; timestampVerified = $true } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:ATTUNER_SIGNING_RECEIPTS -Encoding UTF8
