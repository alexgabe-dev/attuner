param([switch]$AllowServer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows qualification only.' }
# Optional wrapper. The native entry point requires no execution-policy change.
$attunerDriver = Join-Path $PSScriptRoot 'Qualify-Windows.exe'
if ($AllowServer) { & $attunerDriver --allow-server } else { & $attunerDriver }
exit $LASTEXITCODE
