<#
.SYNOPSIS
  Smoke test of a release efre.exe on a Windows CI runner (docs/ARCHITECTURE.md
  sections 8.1, 10 and 11). Used by .github/workflows/ci.yml and release.yml.

.DESCRIPTION
  Starts efre.exe and, for RunSeconds, checks that:
  - efre keeps running;
  - WebView2 starts in efre's own data folder, with --host-resolver-rules;
  - the window, read through UI Automation, shows one of efre's screens, which
    proves the page loads and its IPC works;
  - neither efre.exe nor its WebView2 processes own any TCP or UDP socket, loopback
    included;
  - the image-load mitigation policy is on and efre is excluded from Windows Error
    Reporting.
  Then stops efre and its WebView2 processes. Exits 1 on any problem.

  It refuses to run outside GitHub Actions: it starts efre and force-stops efre's
  WebView2 processes, which you don't want on your own PC.
#>
param(
  # The efre.exe to run, relative to the repository root or absolute.
  [string]$Exe = 'target\release\efre.exe',
  [int]$RunSeconds = 25
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
  throw 'This smoke test runs only on a GitHub Actions runner.'
}
$exe = (Resolve-Path $Exe).Path
$marker = '*\efre\webview*'   # efre's own WebView2 data folder (window.rs)
$runSeconds = $RunSeconds
$problems = [System.Collections.Generic.List[string]]::new()
$sockets = [System.Collections.Generic.List[string]]::new()
$owners = @{}

$wv2Key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv2 = @("HKLM:\SOFTWARE\WOW6432Node\$wv2Key", "HKCU:\Software\$wv2Key") |
  ForEach-Object { (Get-ItemProperty -Path $_ -Name pv -ErrorAction SilentlyContinue).pv } |
  Where-Object { $_ }
if ($wv2) { Write-Host "WebView2 runtime: $($wv2 -join ', ')" }
else { Write-Host '::warning::No WebView2 runtime is registered on this runner' }

function Get-EfreWebViewProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
    Where-Object { $_.CommandLine -like $marker })
}
function Get-ProcessKind([string]$commandLine) {
  if ($commandLine -match '--utility-sub-type=(\S+)') { return "utility $($Matches[1])" }
  if ($commandLine -match '--type=(\S+)') { return $Matches[1] }
  return 'browser'
}

# The window's screens (src/): one of these headings means the page loaded and
# app_status went through IPC. "efre couldn't start" means IPC failed.
$headings = 'Welcome to efre', 'Insert and touch your YubiKey', 'Update Windows to use efre',
  "efre can't open your vault", "efre can't start"
$startupError = "efre couldn't start"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
function Get-EfreUiNames([int]$processId) {
  $condition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $AE::ProcessIdProperty, $processId
  $windows = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  if ($windows.Count -eq 0) { return $null }
  $names = [System.Collections.Generic.List[string]]::new()
  foreach ($window in $windows) {
    $found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($element in $found) {
      try { $name = $element.Current.Name } catch { $name = $null }
      if ($name) { $names.Add($name) }
    }
  }
  return ,$names
}

$efre = Start-Process -FilePath $exe -PassThru
$null = $efre.Handle   # keeps ExitCode readable after an early exit
$samples = 0
$webviewCount = 0
$imageLoad = $null
$resolverRules = @{}
$uiWindow = $false
$uiNames = @()
$uiHeading = $null
$uiNote = $null
$lastUi = [DateTime]::MinValue
try {
  $deadline = (Get-Date).AddSeconds($runSeconds)
  while ((Get-Date) -lt $deadline -and -not $efre.HasExited) {
    $webviews = Get-EfreWebViewProcesses
    $webviewCount = [Math]::Max($webviewCount, $webviews.Count)
    foreach ($process in $webviews) {
      $kind = Get-ProcessKind $process.CommandLine
      $owners[[int]$process.ProcessId] = $kind
      $resolverRules[$kind] = $process.CommandLine -like '*--host-resolver-rules=*'
    }
    $ids = @($efre.Id) + @($webviews | ForEach-Object { [int]$_.ProcessId })
    $owners[[int]$efre.Id] = 'efre.exe'
    Get-NetTCPConnection -ErrorAction SilentlyContinue |
      Where-Object { $ids -contains $_.OwningProcess } |
      ForEach-Object { $sockets.Add("TCP $($owners[[int]$_.OwningProcess]) (pid $($_.OwningProcess)) $($_.LocalAddress):$($_.LocalPort) -> $($_.RemoteAddress):$($_.RemotePort) $($_.State)") }
    Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
      Where-Object { $ids -contains $_.OwningProcess } |
      ForEach-Object { $sockets.Add("UDP $($owners[[int]$_.OwningProcess]) (pid $($_.OwningProcess)) $($_.LocalAddress):$($_.LocalPort)") }
    $samples++
    if (-not $uiHeading -and ((Get-Date) - $lastUi).TotalSeconds -ge 2) {
      $lastUi = Get-Date
      try {
        $names = Get-EfreUiNames $efre.Id
        if ($null -ne $names) {
          $uiWindow = $true
          if ($names.Count -gt 0) { $uiNames = @($names) }
          $uiHeading = $headings | Where-Object { $h = $_; @($names | Where-Object { $_ -like "*$h*" }).Count -gt 0 } | Select-Object -First 1
        }
      } catch {
        $uiNote = "UI Automation error: $_"
      }
    }
    Start-Sleep -Milliseconds 500
  }
  if ($efre.HasExited) {
    $problems.Add("efre.exe exited during the test (exit code $($efre.ExitCode))")
  } else {
    if (Get-Command Get-ProcessMitigation -ErrorAction SilentlyContinue) {
      $imageLoad = (Get-ProcessMitigation -Id $efre.Id).ImageLoad
    }
  }
} catch {
  $problems.Add("smoke test error: $_")
} finally {
  Stop-Process -Id $efre.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Get-EfreWebViewProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($webviewCount -lt 1) {
  $problems.Add("no msedgewebview2.exe with '\efre\webview' in its command line: WebView2 did not start")
} elseif (-not $resolverRules['browser']) {
  $problems.Add('the WebView2 browser process did not get --host-resolver-rules (window.rs)')
}
if ($sockets.Count -gt 0) {
  $problems.Add("$($sockets.Count) socket observation(s) for efre or its WebView2 processes")
}
if (@($uiNames | Where-Object { $_ -like "*$startupError*" }).Count -gt 0) {
  $problems.Add("the window shows '$startupError': its IPC failed")
} elseif (-not $uiHeading) {
  $why = if ($uiNote) { $uiNote } elseif (-not $uiWindow) { 'UI Automation did not find the window' } else { "UI Automation saw: $(($uiNames | Select-Object -First 12) -join ' | ')" }
  $problems.Add("no efre screen heading appeared in the window. $why")
}
# Image-load policy (hardening.rs): fail only on an explicit OFF, so a different
# cmdlet output format is a warning rather than a false failure.
$policy = 'not checked (Get-ProcessMitigation unavailable)'
if ($imageLoad) {
  $policy = 'BlockRemoteImageLoads', 'BlockLowLabelImageLoads', 'PreferSystem32' |
    ForEach-Object {
      $value = "$($imageLoad.$_)"
      if ($value -eq 'OFF') { $problems.Add("image-load policy ${_} is OFF") }
      elseif ($value -ne 'ON') { Write-Host "::warning::image-load policy ${_}: '$value'" }
      "${_}=$value"
    }
  $policy = $policy -join ', '
}
# WerAddExcludedApplication(efre.exe, FALSE) writes this per-user value.
$werKey = 'HKCU:\Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications'
$wer = $null -ne (Get-ItemProperty -Path $werKey -Name 'efre.exe' -ErrorAction SilentlyContinue)
if (-not $wer) { $problems.Add('efre.exe is not in the per-user WER ExcludedApplications list') }

Write-Host '--- efre smoke test ---'
Write-Host "efre.exe pid:            $($efre.Id), ran for $runSeconds s"
Write-Host "WebView2 processes:      $webviewCount (command line contains \efre\webview)"
Write-Host "  kinds:                 $(($owners.Values | Sort-Object -Unique) -join ', ')"
Write-Host "  --host-resolver-rules: $(($resolverRules.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', ')"
Write-Host "screen heading (UIA):    $(if ($uiHeading) { $uiHeading } else { 'not confirmed' })"
Write-Host "network samples:         $samples, socket observations: $($sockets.Count)"
$sockets | Select-Object -Unique | ForEach-Object { Write-Host "  $_" }
if ($sockets.Count -gt 0) {
  Get-NetTCPConnection -State Listen -LocalPort 80, 443 -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  listener $($_.LocalAddress):$($_.LocalPort) pid $($_.OwningProcess) $((Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName)" }
}
Write-Host "image-load policy:       $policy"
Write-Host "WER exclusion (HKCU):    $wer"
if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host 'smoke test: OK'
