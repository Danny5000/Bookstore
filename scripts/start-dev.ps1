[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ApplicationCommand {
  param(
    [Parameter(Mandatory)]
    [string] $Name
  )

  if (-not (Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory)]
    [string] $FilePath,

    [string[]] $ArgumentList = @()
  )

  & $FilePath @ArgumentList
  $commandExitCode = $LASTEXITCODE

  if ($commandExitCode -ne 0) {
    $displayCommand = (@($FilePath) + $ArgumentList) -join ' '
    throw "Command failed with exit code ${commandExitCode}: $displayCommand"
  }
}

function Read-EnvironmentFileValues {
  param(
    [Parameter(Mandatory)]
    [string] $LiteralPath
  )

  $values = @{}
  foreach ($line in Get-Content -LiteralPath $LiteralPath) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      continue
    }
    $value = $Matches[2]
    if ($value.Length -ge 2 -and (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    )) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$Matches[1]] = $value
  }
  return $values
}

function Assert-DatabaseRoleEnvironment {
  param(
    [Parameter(Mandatory)]
    [string] $LiteralPath
  )

  $values = Read-EnvironmentFileValues -LiteralPath $LiteralPath
  $splitRequired = @(
    'DATABASE_OWNER_USER', 'DATABASE_OWNER_PASSWORD',
    'DATABASE_USER', 'DATABASE_PASSWORD',
    'DATABASE_WORKER_USER', 'DATABASE_WORKER_PASSWORD'
  )
  foreach ($name in $splitRequired) {
    if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
      throw 'The existing .env predates the owner/web/worker database role split. Move the existing DATABASE_USER and DATABASE_PASSWORD values to DATABASE_OWNER_USER and DATABASE_OWNER_PASSWORD, choose distinct new web and worker credentials from .env.example, and rerun.'
    }
  }
  foreach ($name in @('DATABASE_STORAGE_CLEANUP_USER', 'DATABASE_STORAGE_CLEANUP_PASSWORD')) {
    if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
      throw 'The existing .env predates the dedicated storage-cleanup database role. Add distinct DATABASE_STORAGE_CLEANUP_USER and DATABASE_STORAGE_CLEANUP_PASSWORD values from .env.example, and rerun.'
    }
  }

  $roleNames = @(
    $values['DATABASE_OWNER_USER'],
    $values['DATABASE_USER'],
    $values['DATABASE_WORKER_USER'],
    $values['DATABASE_STORAGE_CLEANUP_USER']
  )
  if (@($roleNames | Select-Object -Unique).Count -ne 4) {
    throw 'The existing .env must configure distinct owner, web, worker, and storage-cleanup database users.'
  }
  $reservedRoleNames = @(
    'pale_orbit_runtime',
    'pale_orbit_financial_worker',
    'pale_orbit_storage_cleanup'
  )
  foreach ($name in @('DATABASE_USER', 'DATABASE_WORKER_USER', 'DATABASE_STORAGE_CLEANUP_USER')) {
    if ($values[$name] -notmatch '^[a-z][a-z0-9_]{0,62}$' -or
        $reservedRoleNames -contains $values[$name]) {
      throw "The existing .env contains an invalid new database login in $name."
    }
  }
  foreach ($name in @(
    'DATABASE_PASSWORD',
    'DATABASE_WORKER_PASSWORD',
    'DATABASE_STORAGE_CLEANUP_PASSWORD'
  )) {
    if ($values[$name].Length -lt 32 -or $values[$name].Length -gt 256) {
      throw "The existing .env must use a 32-256 character secret in $name."
    }
  }
  $rolePasswords = @(
    $values['DATABASE_OWNER_PASSWORD'],
    $values['DATABASE_PASSWORD'],
    $values['DATABASE_WORKER_PASSWORD'],
    $values['DATABASE_STORAGE_CLEANUP_PASSWORD']
  )
  if (@($rolePasswords | Select-Object -Unique).Count -ne 4) {
    throw 'The existing .env must configure distinct owner, web, worker, and storage-cleanup database passwords.'
  }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$exitCode = 0
$locationPushed = $false

try {
  Push-Location $repositoryRoot
  $locationPushed = $true

  foreach ($requiredCommand in @('node', 'npm', 'docker')) {
    Assert-ApplicationCommand -Name $requiredCommand
  }

  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList @('compose', 'version')

  if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host '[start-dev] Created .env from .env.example.'
  } else {
    Write-Host '[start-dev] Using the existing .env file.'
  }

  Assert-DatabaseRoleEnvironment -LiteralPath '.env'

  Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('ci')

  $composeArguments = @('compose', '--env-file', '.env', '--file', 'compose.dev.yaml')
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('stop', 'app', 'worker', 'storage-cleanup')
  )
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('--profile', 'tools', 'run', '--rm', 'migrate')
  )
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('--profile', 'tools', 'run', '--rm', 'database-role-provision')
  )
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('up', '--build', '--wait')
  )

  Write-Host ''
  Write-Host '[start-dev] Development services are healthy.'
  Write-Host '  Storefront: http://localhost:5173'
  Write-Host '  Mailpit:    http://localhost:8025'
  Write-Host ''
  Write-Host 'Follow logs:'
  Write-Host '  docker compose --env-file .env --file compose.dev.yaml logs --follow app worker'
  Write-Host ''
  Write-Host 'Stop services without deleting data:'
  Write-Host '  docker compose --env-file .env --file compose.dev.yaml down'
} catch {
  [Console]::Error.WriteLine("[start-dev] $($_.Exception.Message)")
  $exitCode = 1
} finally {
  if ($locationPushed) {
    Pop-Location
  }
}

exit $exitCode
