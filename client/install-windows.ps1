[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RelayUrl,

  [string]$DeviceName = 'Command Center Windows Client',
  [string]$HermesBin = '',
  [string]$CredentialFile = '',
  [string]$TaskName = 'CommandCenter Relay Client',
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$clientScript = Join-Path $PSScriptRoot 'command-center-relay.mjs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$principalId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not $CredentialFile) {
  $CredentialFile = Join-Path $env:LOCALAPPDATA 'CommandCenter\relay-device.json'
}

if (-not $HermesBin) {
  $hermesCommand = Get-Command hermes.exe -ErrorAction SilentlyContinue
  if ($hermesCommand) { $HermesBin = $hermesCommand.Source }
  else { $HermesBin = 'hermes' }
}

if (-not (Test-Path -LiteralPath $clientScript -PathType Leaf)) {
  throw "Client script was not found: $clientScript"
}

if (-not (Test-Path -LiteralPath $CredentialFile -PathType Leaf)) {
  Write-Host 'No protected relay credential found. The client will prompt for the one-time pairing secret without echoing it.'
  & $nodePath $clientScript `
    --relay-url $RelayUrl `
    --pairing-secret-stdin `
    --credential-file $CredentialFile `
    --device-name $DeviceName `
    --hermes-bin $HermesBin `
    --once
  if ($LASTEXITCODE -ne 0) { throw "Relay enrollment failed with exit code $LASTEXITCODE." }
}

$taskArguments = @(
  "`"$clientScript`""
  '--relay-url'
  "`"$RelayUrl`""
  '--credential-file'
  "`"$CredentialFile`""
  '--device-name'
  "`"$DeviceName`""
  '--hermes-bin'
  "`"$HermesBin`""
) -join ' '

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $taskArguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $principalId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

if (-not $SkipStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
}

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  LastTaskResult = $info.LastTaskResult
  CredentialFile = $CredentialFile
  RelayUrl = $RelayUrl
  HermesBin = $HermesBin
  Started = (-not $SkipStart)
} | Format-List
