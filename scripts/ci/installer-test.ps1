<#
.SYNOPSIS
  Installer test on a Windows CI runner (docs/ARCHITECTURE.md section 9). Used by
  .github/workflows/ci.yml and release.yml.

.DESCRIPTION
  Silently installs the NSIS setup in BundleDir, then checks that efre landed in
  %LOCALAPPDATA%\Programs\efre, never in the vault folder %LOCALAPPDATA%\efre, and is
  registered there. Silently uninstalls it, then checks that a stand-in vault.efre is
  byte-identical, the webview folder is still there, and the uninstall registry key
  and WER exclusion are gone. Exits 1 on any problem.

  It writes a stand-in %LOCALAPPDATA%\efre\vault.efre, so it refuses to run outside
  GitHub Actions, and anywhere a vault already exists.
#>
param(
  # The folder that holds the one *-setup.exe to test.
  [string]$BundleDir = 'target\release\bundle\nsis'
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
  throw 'This installer test runs only on a GitHub Actions runner.'
}
$problems = [System.Collections.Generic.List[string]]::new()
function Invoke-Waited($file, [string[]]$arguments) {
  $p = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  $null = $p.Handle
  if (-not $p.WaitForExit(180000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw "$file did not finish within 3 minutes"
  }
  return $p.ExitCode
}
$setup = @(Get-ChildItem (Join-Path $BundleDir '*-setup.exe'))
if ($setup.Count -ne 1) { throw "expected one NSIS installer, found $($setup.Count)" }
$vaultDir = Join-Path $env:LOCALAPPDATA 'efre'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\efre'
$werKey = 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications'

# A stand-in vault: these bytes must survive install and uninstall unchanged.
New-Item -ItemType Directory -Force -Path $vaultDir | Out-Null
$sentinel = Join-Path $vaultDir 'vault.efre'
if (Test-Path $sentinel) { throw "$sentinel already exists: this test never overwrites a vault" }
[IO.File]::WriteAllBytes($sentinel, [byte[]](1..255))
$hash = (Get-FileHash $sentinel).Hash

$code = Invoke-Waited $setup[0].FullName @('/S')
if ($code -ne 0) { $problems.Add("silent install exited with $code") }
if (-not (Test-Path (Join-Path $installDir 'efre.exe'))) { $problems.Add("efre.exe is not in $installDir") }
foreach ($file in 'efre.exe', 'uninstall.exe') {
  if (Test-Path (Join-Path $vaultDir $file)) { $problems.Add("$file was installed into the vault folder") }
}
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\efre'
$location = (Get-ItemProperty -Path $uninstallKey -ErrorAction SilentlyContinue).InstallLocation
Write-Host "registered install location: $location"
if ("$location".Trim('"') -ne $installDir) { $problems.Add("InstallLocation is '$location'") }

# `_?=` runs the uninstaller in place, so waiting for it covers the whole uninstall.
$uninstaller = Join-Path $installDir 'uninstall.exe'
if (Test-Path $uninstaller) {
  $code = Invoke-Waited $uninstaller @('/S', "_?=$installDir")
  if ($code -ne 0) { $problems.Add("silent uninstall exited with $code") }
  if (Test-Path (Join-Path $installDir 'efre.exe')) { $problems.Add('the uninstaller left efre.exe') }
  if (Test-Path $uninstallKey) { $problems.Add('the uninstall registry key is still there') }
  if ($null -ne (Get-ItemProperty -Path $werKey -Name 'efre.exe' -ErrorAction SilentlyContinue)) {
    $problems.Add('the uninstaller left the WER exclusion value')
  }
}
if (-not (Test-Path $sentinel)) { $problems.Add('the vault file is gone') }
elseif ((Get-FileHash $sentinel).Hash -ne $hash) { $problems.Add('the vault file changed') }
if (-not (Test-Path (Join-Path $vaultDir 'webview'))) { $problems.Add("the smoke test's webview folder is gone") }

Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
Remove-Item -Force $sentinel -ErrorAction SilentlyContinue
if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "installer: OK (installed to $installDir; vault folder untouched)"
