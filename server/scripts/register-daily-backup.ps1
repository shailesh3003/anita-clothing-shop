$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backupScript = Join-Path $PSScriptRoot 'backup-postgres.ps1'
if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) { throw 'Backup script was not found.' }
$powershell = (Get-Process -Id $PID).Path
if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { throw 'Could not locate the current PowerShell executable.' }

$taskName = 'Anita Clothing Shop PostgreSQL Backup'
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$backupScript`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At '2:00 AM'
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Creates a local custom-format PostgreSQL backup daily and retains 30 days.' -Force -ErrorAction Stop | Out-Null
Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
Write-Output "Registered '$taskName' to run daily at 2:00 AM local time."
