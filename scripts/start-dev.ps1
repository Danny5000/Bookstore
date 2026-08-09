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

  Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('ci')

  $composeArguments = @('compose', '--env-file', '.env', '--file', 'compose.dev.yaml')
  Invoke-CheckedCommand -FilePath 'docker' -ArgumentList (
    $composeArguments + @('--profile', 'tools', 'run', '--rm', 'migrate')
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
