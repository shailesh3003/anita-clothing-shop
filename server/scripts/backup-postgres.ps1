param(
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 30
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envFile = Join-Path $projectRoot '.env'
$backupRoot = Join-Path $env:LOCALAPPDATA 'AnitaClothingShop\backups'
$logPath = Join-Path $backupRoot 'backup.log'
$partialPath = $null

function Set-PrivateBackupAcl([string]$Path) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl = Get-Acl -LiteralPath $Path
  $allowedSids = @($currentSid.Value, $systemSid.Value)
  $existingRules = @($acl.Access)
  $alreadyPrivate = $acl.AreAccessRulesProtected -and $existingRules.Count -eq 2 -and @($existingRules | Where-Object {
    $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    -not $_.FileSystemRights.HasFlag([System.Security.AccessControl.FileSystemRights]::FullControl) -or
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowedSids
  }).Count -eq 0
  if ($alreadyPrivate) { return }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleAll($existingRule) }
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($currentSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.SetAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

try {
  if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'Project .env file was not found.' }
  if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  }
  Set-PrivateBackupAcl $backupRoot

  $databaseLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  if (-not $databaseLine) { throw 'DATABASE_URL is not configured in the project .env file.' }
  $databaseUrl = $databaseLine.Substring('DATABASE_URL='.Length).Trim().Trim('"').Trim("'")
  $uri = [System.Uri]::new($databaseUrl)
  if ($uri.Scheme -notin @('postgres', 'postgresql')) { throw 'DATABASE_URL must use PostgreSQL.' }
  $credentials = $uri.UserInfo
  $separator = $credentials.IndexOf(':')
  if ($separator -lt 1) { throw 'DATABASE_URL must include a database username and password.' }
  $dbUser = [System.Uri]::UnescapeDataString($credentials.Substring(0, $separator))
  $dbPassword = [System.Uri]::UnescapeDataString($credentials.Substring($separator + 1))
  $dbName = [System.Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
  $dbPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
  if (-not $dbName -or -not $dbUser -or -not $dbPassword) { throw 'DATABASE_URL is missing required PostgreSQL connection parts.' }

  $pgDump = Join-Path $env:ProgramFiles 'PostgreSQL\18\bin\pg_dump.exe'
  if (-not (Test-Path -LiteralPath $pgDump -PathType Leaf)) {
    $pgDumpCommand = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
    if (-not $pgDumpCommand) { throw 'pg_dump was not found. Install PostgreSQL client tools or update this script path.' }
    $pgDump = $pgDumpCommand.Source
  }

  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $fileName = "anita-clothing-shop-$stamp.dump"
  $backupPath = Join-Path $backupRoot $fileName
  $partialPath = "$backupPath.partial"
  $env:PGPASSWORD = $dbPassword
  if ((Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_SSL=true$' } | Select-Object -First 1)) {
    $env:PGSSLMODE = 'verify-full'
  }
  $arguments = @('--host', $uri.Host, '--port', [string]$dbPort, '--username', $dbUser, '--dbname', $dbName, '--format=custom', '--no-owner', '--no-acl', '--file', $partialPath)
  & $pgDump @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE." }
  if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf) -or (Get-Item -LiteralPath $partialPath).Length -eq 0) { throw 'pg_dump did not produce a valid backup file.' }
  Move-Item -LiteralPath $partialPath -Destination $backupPath
  $partialPath = $null

  $cutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $backupRoot -Filter 'anita-clothing-shop-*.dump' -File |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force
  $entry = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') local-time SUCCESS $fileName $((Get-Item -LiteralPath $backupPath).Length) bytes"
  Add-Content -LiteralPath $logPath -Value $entry
  Write-Output "Backup created: $fileName"
} catch {
  if ($partialPath -and (Test-Path -LiteralPath $partialPath)) { Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $backupRoot -PathType Container) {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') local-time FAILED; check the task history and PostgreSQL client configuration."
  }
  throw $_
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue
}
