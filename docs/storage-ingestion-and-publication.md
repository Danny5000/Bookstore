# Storage, ingestion, publication, and recovery

## Safety boundaries

Publication files are private application data. `STORAGE_PROVIDER=local` stores them beneath `STORAGE_LOCAL_ROOT`; development uses the ignored `.data/storage` directory and production mounts the private `book_storage` volume at `/var/lib/pale-orbit/storage`. Caddy never receives that volume. Browser data and audit summaries never contain storage keys or the local root.

The storage interface owns opaque keys. `staging/uploads/...` objects are temporary, `titles/.../derived/v1/...` objects are reproducible, `titles/.../covers/...` objects are explicit title covers, and every `titles/.../revisions/.../original` object is immutable retained source material. Cleanup categorically refuses to delete originals. `STORAGE_PROVIDER=s3` is a deliberate fail-at-startup stub; no AWS SDK or partial S3 implementation is installed.

## Development and upload operations

For host-run development, create `.env`, start dependencies, migrate, bootstrap once, then keep web and worker in separate terminals:

```powershell
Copy-Item .env.example .env
docker compose --env-file .env --file compose.dev.yaml up postgres mailpit --detach --wait
npm run db:migrate
npm run admin:bootstrap
npm run dev
```

```powershell
npm run worker:watch
```

For fully containerized development:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

Sign in as the bootstrapped administrator, open `/admin/catalog`, create a private title, and use its **Upload revision** form. Upload accepts one bounded EPUB for prose or CBZ/ZIP image archive for comics. The request streams the file to storage; the worker performs ingestion. Do not stop the worker while expecting a revision to advance from uploaded/processing to ready for review.

## Ingestion failures and retry

The admin review page shows only safe failure codes and messages. Limit, unsafe-path, encryption, compression, malformed EPUB/XML, unsupported content/media, image decode/pixel, CRC, and missing-source failures are permanent for that file. Correct the source and upload a new immutable revision.

Database, storage, timeout, and worker-abort failures are transient. PostgreSQL jobs retry them automatically with bounded backoff until `maxAttempts`. When a revision is in `failed` and its staged source still matches the recorded size and SHA-256 checksum, **Retry ingestion** creates a new generation and job. If the source is absent or mismatched, retry is disabled and a new upload is required. Never edit an original or derived object in place.

## Review and publication lifecycle

1. Review all extracted prose blocks or comic pages and retained-original metadata.
2. Explicitly confirm a cover suggestion, or upload a separate title cover. Revision activation never changes the title cover.
3. Edit draft preview boundaries, reading direction, and comic panel regions. Draft changes remain admin-only.
4. Use **Publish reader settings** to promote one complete presentation atomically.
5. Use **Activate privately** for a first revision that should remain unavailable publicly.
6. Use **Publish to storefront** for first publication. A public replacement remains invisible until **Publish replacement** atomically switches the active revision.
7. **Roll back** switches to a prior ready/retired revision and its published settings. **Withdraw** makes catalog, detail, and preview routes unavailable without deleting admin review, active customer entitlements, or retained originals. Entitled customers continue to use the current active publication; see [customer library, reader state, and original downloads](customer-library-and-reader.md).

Metadata saves on a public title are explicit and become public after the successful transaction. Candidate processing, draft settings, and failed revisions never alter the current public reader.

## Cleanup and disk capacity

Always review a dry run before apply. Output is aggregate JSON only; object keys are never logged.

Host-run development:

```powershell
npm run storage:cleanup
npm run storage:cleanup -- --apply
```

Compose development:

```powershell
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm storage-cleanup
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm storage-cleanup npm run storage:cleanup:raw -- --apply
```

Production, using the already-exported deployment environment (never a production `.env` file):

```powershell
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup
docker compose --file compose.prod.yaml --profile tools run --rm storage-cleanup node build/services/cleanup-storage.js --apply
```

Cleanup scans in pages of at most 500. It deletes only staging objects older than `STORAGE_STAGING_RETENTION_HOURS` that have no uploaded/processing revision or active job, and derived/cover objects older than `STORAGE_ORPHAN_RETENTION_HOURS` that have no database reference. Any storage or database error stops the run.

Monitor the Docker data filesystem with `Get-PSDrive`/`df -h` and the volume with the same approved immutable helper used by backup, for example `docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v <project>_book_storage:/data:ro "$BACKUP_HELPER_IMAGE" du -sh /data`. Alert at 75% filesystem use. At 85%, stop new uploads before continuing: announce the maintenance window and stop `app` if an upload-specific edge rule is unavailable, allow the worker to finish current work, run cleanup dry-run/apply, expand storage, and verify headroom before restarting. Do not let the filesystem reach 90%.

## Coordinated backup

Use a maintenance window so the database and private volume represent the same application point. Keep both `app` and the general `worker` stopped from the first dump through every authenticated source baseline. The operator must supply an explicit Compose project, approved Docker context, expected engine ID, exact application image digest, audited plaintext-disposition wrapper, and audited seal/transfer wrapper. Never infer a production Docker target from the current CLI context.

On Windows PowerShell, create a collision-safe workspace on encrypted-at-rest storage, remove inherited access, grant only the current operator, validate the ACL and owner, and arm disposition before the first production mutation:

```powershell
$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Assert-NativeSuccess {
  param([Parameter(Mandatory)][string]$Operation)
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed with native exit code $LASTEXITCODE" }
}
function New-RestrictedWorkspace {
  param(
    [Parameter(Mandatory)][string]$Parent,
    [Parameter(Mandatory)][string]$Prefix
  )
  $resolvedParent = (Resolve-Path -LiteralPath $Parent -ErrorAction Stop).Path
  $parentItem = Get-Item -LiteralPath $resolvedParent -Force -ErrorAction Stop
  if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Workspace parent must be a resolved non-reparse directory'
  }
  $workspace = Join-Path $resolvedParent ($Prefix + [guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $workspace -ErrorAction Stop
  $workspace = (Resolve-Path -LiteralPath $workspace -ErrorAction Stop).Path
  $workspaceItem = Get-Item -LiteralPath $workspace -Force -ErrorAction Stop
  if (-not $workspaceItem.PSIsContainer -or ($workspaceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Workspace must be a non-reparse directory'
  }
  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $null = & icacls.exe $workspace /setowner $currentIdentity
  Assert-NativeSuccess 'set restricted workspace owner'
  $null = & icacls.exe $workspace /inheritance:r
  Assert-NativeSuccess 'remove inherited workspace access'
  $null = & icacls.exe $workspace /grant:r "${currentIdentity}:(OI)(CI)F"
  Assert-NativeSuccess 'grant current operator workspace access'
  $acl = Get-Acl -LiteralPath $workspace -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected -or $acl.Owner -ne $currentIdentity) {
    throw 'Restricted workspace ACL or owner validation failed'
  }
  $foreignAllow = @($acl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $_.IdentityReference.Value -ne $currentIdentity
  })
  if ($foreignAllow.Count -ne 0) { throw 'Restricted workspace grants another identity' }
  if (@(Get-ChildItem -LiteralPath $workspace -Force -ErrorAction Stop).Count -ne 0) {
    throw 'Restricted workspace is not empty'
  }
  return $workspace
}
function Invoke-PlaintextDisposition {
  param([Parameter(Mandatory)][string]$Workspace)
  $resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
  $workspaceItem = Get-Item -LiteralPath $resolvedWorkspace -Force -ErrorAction Stop
  if (-not $workspaceItem.PSIsContainer -or ($workspaceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Disposition target must be a resolved non-reparse directory'
  }
  & $env:PLAINTEXT_DISPOSITION_COMMAND dispose $resolvedWorkspace
  Assert-NativeSuccess 'apply approved plaintext disposition'
}
function ConvertTo-CanonicalBackupText {
  param(
    [Parameter(Mandatory)][object[]]$Lines,
    [Parameter(Mandatory)][string]$Header
  )
  $normalized = (($Lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Replace([char]13, '')
  $normalizedLines = @($normalized -split [char]10)
  if ($normalizedLines.Count -lt 1 -or $normalizedLines[0] -ne $Header) {
    throw "Canonical backup output has the wrong header: $Header"
  }
  return ($normalizedLines -join [char]10) + [char]10
}
function Assert-SourceDockerEngineBinding {
  $observedEngine = @(& docker --context $sourceDockerContext info --format '{{.ID}}')
  Assert-NativeSuccess 'read approved source Docker engine ID'
  if ($observedEngine.Count -ne 1 -or $observedEngine[0].Trim() -ne $expectedSourceDockerEngineId) {
    throw 'Approved source Docker engine ID does not match'
  }
}
function Assert-SourceServicesStopped {
  $runningServices = @(& docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml ps --status running -q app worker)
  Assert-NativeSuccess 'verify production app and worker are stopped'
  if (@($runningServices | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) {
    throw 'Production app and worker must remain stopped'
  }
}
function Assert-SourceApplicationImageBinding {
  Assert-SourceDockerEngineBinding
  $expectedImageIds = @(& docker --context $sourceDockerContext image inspect $env:APP_IMAGE --format '{{.Id}}')
  Assert-NativeSuccess 'inspect exact source application image ID'
  if ($expectedImageIds.Count -ne 1 -or $expectedImageIds[0] -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Exact source application image ID is invalid'
  }
  foreach ($service in @('app', 'worker')) {
    $serviceIds = @(& docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml ps --all -q $service)
    Assert-NativeSuccess "locate stopped production $service container"
    if ($serviceIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace($serviceIds[0])) {
      throw "Expected exactly one stopped production $service container"
    }
    $containerImageIds = @(& docker --context $sourceDockerContext inspect --type container --format '{{.Image}}' $serviceIds[0].Trim())
    Assert-NativeSuccess "inspect stopped production $service container image"
    if ($containerImageIds.Count -ne 1 -or $containerImageIds[0].Trim() -ne $expectedImageIds[0].Trim()) {
      throw "Stopped production $service container does not use APP_IMAGE"
    }
  }
}
function Assert-SourcePostgresImageBinding {
  param([Parameter(Mandatory)][string]$ContainerId)
  Assert-SourceDockerEngineBinding
  $expectedPostgresImageIds = @(& docker --context $sourceDockerContext image inspect $env:POSTGRES_IMAGE --format '{{.Id}}')
  Assert-NativeSuccess 'inspect exact source PostgreSQL image ID'
  if ($expectedPostgresImageIds.Count -ne 1 -or $expectedPostgresImageIds[0] -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Exact source PostgreSQL image ID is invalid'
  }
  $containerImageIds = @(& docker --context $sourceDockerContext inspect --type container --format '{{.Image}}' $ContainerId)
  Assert-NativeSuccess 'inspect production PostgreSQL container image'
  if ($containerImageIds.Count -ne 1 -or $containerImageIds[0].Trim() -ne $expectedPostgresImageIds[0].Trim()) {
    throw 'Production PostgreSQL container does not use POSTGRES_IMAGE'
  }
}
function Assert-SourceHelperImageBinding {
  Assert-SourceDockerEngineBinding
  $helperRepoDigestOutput = @(& docker --context $sourceDockerContext image inspect $env:BACKUP_HELPER_IMAGE --format '{{range .RepoDigests}}{{println .}}{{end}}')
  Assert-NativeSuccess 'inspect exact source backup helper image'
  if ($helperRepoDigestOutput -notcontains $env:BACKUP_HELPER_IMAGE) {
    throw 'Source engine lacks exact BACKUP_HELPER_IMAGE RepoDigest'
  }
}
function Assert-SourceStorageSamples {
  param([Parameter(Mandatory)][string]$SampleFile)
  $rows = @(Import-Csv -LiteralPath $SampleFile -ErrorAction Stop)
  foreach ($row in $rows) {
    if ($row.sample_kind -notin @('cover', 'revision_original', 'prose_image', 'comic_page', 'revision_cover_suggestion') -or
        [string]::IsNullOrWhiteSpace($row.storage_key) -or
        $row.storage_key -match '(^/|(^|/)\.\.(/|$))' -or
        $row.checksum_sha256 -notmatch '^[0-9a-f]{64}$') {
      throw 'Authenticated storage sample is unsafe or malformed'
    }
    Assert-SourceDockerEngineBinding
    $digestOutput = @(& docker --context $sourceDockerContext run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${project}_book_storage:/data:ro" $env:BACKUP_HELPER_IMAGE sha256sum -- "/data/$($row.storage_key)")
    Assert-NativeSuccess 'hash source storage sample'
    if ($digestOutput.Count -ne 1) { throw 'Source storage digest output is ambiguous' }
    $actualDigest = (($digestOutput[0] -split '\s+')[0]).ToLowerInvariant()
    if ($actualDigest -notmatch '^[0-9a-f]{64}$' -or $actualDigest -ne $row.checksum_sha256) {
      throw 'Source storage sample mismatch'
    }
  }
}

foreach ($requiredVariable in @(
  'COMPOSE_PROJECT_NAME', 'APPROVED_SOURCE_DOCKER_CONTEXT',
  'EXPECTED_SOURCE_DOCKER_ENGINE_ID', 'APP_IMAGE', 'POSTGRES_IMAGE',
  'BACKUP_HELPER_IMAGE',
  'PLAINTEXT_DISPOSITION_COMMAND', 'BACKUP_SEAL_TRANSFER_COMMAND',
  'BACKUP_SOURCE_CIPHERTEXT'
)) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($requiredVariable))) {
    throw "$requiredVariable is required"
  }
}
$project = $env:COMPOSE_PROJECT_NAME.Trim().ToLowerInvariant()
if ($project -notmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'COMPOSE_PROJECT_NAME is invalid' }
$sourceDockerContext = $env:APPROVED_SOURCE_DOCKER_CONTEXT.Trim()
if ($sourceDockerContext -notmatch '^[A-Za-z0-9_.-]{1,128}$') { throw 'Approved source Docker context is invalid' }
$productionDockerContext = $sourceDockerContext
$expectedSourceDockerEngineId = $env:EXPECTED_SOURCE_DOCKER_ENGINE_ID.Trim()
if ($expectedSourceDockerEngineId -notmatch '^[A-Za-z0-9:_.-]{1,128}$') { throw 'Expected source Docker engine ID is invalid' }
$productionDockerEngineId = $expectedSourceDockerEngineId
if ($env:APP_IMAGE -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') {
  throw 'APP_IMAGE must be an exact repository digest'
}
if ($env:POSTGRES_IMAGE -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') {
  throw 'POSTGRES_IMAGE must be an exact repository digest'
}
if ($env:BACKUP_HELPER_IMAGE -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') {
  throw 'BACKUP_HELPER_IMAGE must be an exact repository digest'
}
$contextInspection = @(& docker --context $sourceDockerContext context inspect $sourceDockerContext --format '{{.Name}}')
Assert-NativeSuccess 'inspect approved source Docker context'
if ($contextInspection.Count -ne 1 -or $contextInspection[0].Trim() -ne $sourceDockerContext) {
  throw 'Approved source Docker context does not resolve exactly'
}
Assert-SourceDockerEngineBinding
Assert-SourceHelperImageBinding

$backup = New-RestrictedWorkspace -Parent $PWD -Prefix 'backup-'
$sourceWorkspaceDispositionArmed = $true
try {
  Assert-SourceDockerEngineBinding
  & docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml stop app worker
  Assert-NativeSuccess 'stop production app and worker'
  Assert-SourceServicesStopped
  Assert-SourceApplicationImageBinding

  $postgresIds = @(& docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml ps -q postgres)
  Assert-NativeSuccess 'locate production PostgreSQL container'
  if ($postgresIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace($postgresIds[0])) {
    throw 'Expected exactly one production PostgreSQL container'
  }
  $postgres = $postgresIds[0].Trim()
  Assert-SourcePostgresImageBinding $postgres

  $containerDumpCreated = $false
  try {
    $containerDumpCreated = $true
    Assert-SourceDockerEngineBinding
    & docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml exec -T postgres pg_dump -U $env:DATABASE_USER -d $env:DATABASE_NAME --format=custom --file=/tmp/pale-orbit.dump
    Assert-NativeSuccess 'create PostgreSQL logical dump'
    Assert-SourceDockerEngineBinding
    & docker --context $sourceDockerContext cp "${postgres}:/tmp/pale-orbit.dump" (Join-Path $backup 'database.dump')
    Assert-NativeSuccess 'copy PostgreSQL logical dump'
  } finally {
    if ($containerDumpCreated) {
      Assert-SourceDockerEngineBinding
      & docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml exec -T postgres rm -f /tmp/pale-orbit.dump
      Assert-NativeSuccess 'remove PostgreSQL container dump copy'
      $containerDumpCreated = $false
    }
  }

  $migrationJournal = @(& docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 -U $env:DATABASE_USER -d $env:DATABASE_NAME -c 'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with (format csv, header true)')
  Assert-NativeSuccess 'capture migration journal'
  $migrationText = ConvertTo-CanonicalBackupText -Lines $migrationJournal -Header 'id,hash,created_at'
  [System.IO.File]::WriteAllText((Join-Path $backup 'migration-journal.csv'), $migrationText, $utf8NoBom)

  $rowCountSql = Get-Content -LiteralPath 'scripts/capture-restore-row-counts.sql' -Raw -ErrorAction Stop
  $rowCountOutput = @($rowCountSql | & docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U $env:DATABASE_USER -d $env:DATABASE_NAME)
  Assert-NativeSuccess 'capture complete source row counts'
  $rowCountText = ConvertTo-CanonicalBackupText -Lines $rowCountOutput -Header 'schema_name,table_name,row_count'
  [System.IO.File]::WriteAllText((Join-Path $backup 'restore-row-counts.csv'), $rowCountText, $utf8NoBom)

  $storageSampleSql = Get-Content -LiteralPath 'scripts/capture-storage-samples.sql' -Raw -ErrorAction Stop
  $storageSampleOutput = @($storageSampleSql | & docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U $env:DATABASE_USER -d $env:DATABASE_NAME)
  Assert-NativeSuccess 'capture source storage samples'
  $storageSampleText = ConvertTo-CanonicalBackupText -Lines $storageSampleOutput -Header 'sample_kind,storage_key,checksum_sha256'
  [System.IO.File]::WriteAllText((Join-Path $backup 'storage-samples.csv'), $storageSampleText, $utf8NoBom)

  Copy-Item -LiteralPath 'scripts/verify-financial-restore.sql' -Destination (Join-Path $backup 'verify-financial-restore.sql') -ErrorAction Stop
  $sourceVerifierSql = Get-Content -LiteralPath (Join-Path $backup 'verify-financial-restore.sql') -Raw -ErrorAction Stop # psql ON_ERROR_STOP source verifier
  $sourceVerifierOutput = @($sourceVerifierSql | & docker --context $sourceDockerContext compose --project-name $project --file compose.prod.yaml exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U $env:DATABASE_USER -d $env:DATABASE_NAME)
  Assert-NativeSuccess 'verify source credential and financial invariants'

  Assert-SourceDockerEngineBinding
  $storageArchive = Join-Path $backup 'storage.tar.gz'
  $null = New-Item -ItemType File -Path $storageArchive -ErrorAction Stop
  & docker --context $sourceDockerContext run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${project}_book_storage:/source:ro" -v "${storageArchive}:/output/storage.tar.gz" $env:BACKUP_HELPER_IMAGE tar -C /source -czf /output/storage.tar.gz .
  Assert-NativeSuccess 'archive private storage volume'
  Assert-SourceStorageSamples (Join-Path $backup 'storage-samples.csv')
  Assert-SourceServicesStopped

  $applicationImageDigest = @(& docker --context $sourceDockerContext image inspect $env:APP_IMAGE --format '{{json .RepoDigests}}')
  Assert-NativeSuccess 'inspect exact application image RepoDigests'
  if ($applicationImageDigest.Count -ne 1 -or [string]::IsNullOrWhiteSpace($applicationImageDigest[0])) {
    throw 'Application image RepoDigests output is empty'
  }
  $repoDigestJson = $applicationImageDigest[0].Trim()
  if (-not ($repoDigestJson.StartsWith('[') -and $repoDigestJson.EndsWith(']'))) {
    throw 'Application image RepoDigests must be a JSON array'
  }
  $repoDigests = @($repoDigestJson | ConvertFrom-Json -ErrorAction Stop)
  $validRepoDigests = @($repoDigests | Where-Object {
    $_ -is [string] -and $_ -match '^[^@\s]+@sha256:[0-9a-f]{64}$'
  })
  if ($validRepoDigests.Count -lt 1 -or $validRepoDigests.Count -ne $repoDigests.Count -or
      $repoDigests -notcontains $env:APP_IMAGE) {
    throw 'RepoDigests does not contain the exact APP_IMAGE'
  }
  $applicationImageJson = [ordered]@{
    APP_IMAGE = $env:APP_IMAGE
    POSTGRES_IMAGE = $env:POSTGRES_IMAGE
    BACKUP_HELPER_IMAGE = $env:BACKUP_HELPER_IMAGE
    RepoDigests = $repoDigests
  } |
    ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $backup 'application-image.json'), $applicationImageJson, $utf8NoBom)

  $sourceEngineJson = [ordered]@{
    docker_context = $sourceDockerContext
    docker_engine_id = $expectedSourceDockerEngineId
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $backup 'source-docker-engine.json'), $sourceEngineJson, $utf8NoBom)

  $requiredBackupFiles = @(
    'database.dump'
    'storage.tar.gz'
    'migration-journal.csv'
    'application-image.json'
    'restore-row-counts.csv'
    'storage-samples.csv'
    'source-docker-engine.json'
    'verify-financial-restore.sql'
  )
  $sourceEntries = @(Get-ChildItem -LiteralPath $backup -Force -ErrorAction Stop)
  $unsafeSourceEntries = @($sourceEntries | Where-Object {
    $_.PSIsContainer -or ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  })
  if ($unsafeSourceEntries.Count -ne 0) { throw 'Source workspace contains an unsafe entry' }
  $sourceNames = @($sourceEntries.Name | Sort-Object)
  if (@(Compare-Object -ReferenceObject ($requiredBackupFiles | Sort-Object) -DifferenceObject $sourceNames).Count -ne 0) {
    throw 'Source workspace inventory mismatch before manifest'
  }
  $manifestLines = foreach ($name in $requiredBackupFiles) {
    $path = Join-Path $backup $name
    $requiredItem = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($requiredItem.Length -le 0) { throw "Required backup file is missing or empty: $name" }
    $actualDigest = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($actualDigest -notmatch '^[0-9a-f]{64}$') { throw "Invalid SHA-256 for $name" }
    "$actualDigest *$name"
  }
  Set-Content -LiteralPath (Join-Path $backup 'backup-file-manifest.sha256') -Value $manifestLines -Encoding ascii -ErrorAction Stop

  Assert-SourceServicesStopped
  Assert-SourceDockerEngineBinding
  $sourceCiphertextPath = [System.IO.Path]::GetFullPath($env:BACKUP_SOURCE_CIPHERTEXT)
  & $env:BACKUP_SEAL_TRANSFER_COMMAND seal-transfer $backup $sourceCiphertextPath
  Assert-NativeSuccess 'seal and transfer authenticated backup'
  $sourceCiphertextSha256 = (Get-FileHash -LiteralPath $sourceCiphertextPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if ($sourceCiphertextSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Source ciphertext SHA-256 is invalid' }
  Write-Output "BACKUP_SOURCE_CIPHERTEXT_SHA256=$sourceCiphertextSha256"
} finally {
  if ($sourceWorkspaceDispositionArmed) {
    Invoke-PlaintextDisposition $backup
    $sourceWorkspaceDispositionArmed = $false
  }
}
```

On the GNU/Linux production VPS, the equivalent path is fully context-bound and installs one EXIT trap immediately after creating the source workspace. The trap cleans a possibly partial container dump and applies the approved success/failure disposition even if copying, manifesting, or sealing fails:

```sh
set -eu
umask 077
export LC_ALL=C

new_restricted_workspace() {
  parent="$(readlink -f -- "$1")" || return 1
  prefix=$2
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  workspace="$(mktemp -d --tmpdir="$parent" "${prefix}XXXXXXXX")" || return 1
  workspace="$(readlink -f -- "$workspace")" || return 1
  [ -d "$workspace" ] && [ ! -L "$workspace" ] || return 1
  [ "$(stat -c '%u' -- "$workspace")" = "$(id -u)" ] || return 1
  chmod 700 -- "$workspace" || return 1
  [ "$(stat -c '%a' -- "$workspace")" = 700 ] || return 1
  workspace_entries="$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
  [ -z "$workspace_entries" ] || return 1
  printf '%s\n' "$workspace"
}
normalize_compose_project() {
  normalized_project="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" || return 1
  printf '%s\n' "$normalized_project" | grep -Eq '^[a-z0-9][a-z0-9_-]*$' || return 1
  printf '%s\n' "$normalized_project"
}
source_docker() {
  docker --context "$source_docker_context" "$@"
}
compose_prod() {
  source_docker compose --project-name "$project" --file compose.prod.yaml "$@"
}
assert_source_engine_binding() {
  observed_source_engine="$(source_docker info --format '{{.ID}}')" || return 1
  [ "$observed_source_engine" = "$expected_source_docker_engine_id" ] || return 1
}
assert_source_services_stopped() {
  running_services="$(compose_prod ps --status running -q app worker)" || return 1
  [ -z "$running_services" ] || return 1
}
assert_source_application_image_binding() {
  assert_source_engine_binding || return 1
  expected_image_id="$(source_docker image inspect "$APP_IMAGE" --format '{{.Id}}')" || return 1
  printf '%s\n' "$expected_image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || return 1
  for service in app worker; do
    service_ids="$(compose_prod ps --all -q "$service")" || return 1
    [ "$(printf '%s\n' "$service_ids" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] || return 1
    service_id="$(printf '%s\n' "$service_ids" | awk 'NF { print; exit }')" || return 1
    container_image_id="$(source_docker inspect --type container --format '{{.Image}}' "$service_id")" || return 1
    [ "$container_image_id" = "$expected_image_id" ] || return 1
  done
}
assert_source_postgres_image_binding() {
  [ "$#" -eq 1 ] || return 1
  assert_source_engine_binding || return 1
  expected_postgres_image_id="$(source_docker image inspect "$POSTGRES_IMAGE" --format '{{.Id}}')" || return 1
  printf '%s\n' "$expected_postgres_image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || return 1
  postgres_container_image_id="$(source_docker inspect --type container --format '{{.Image}}' "$1")" || return 1
  [ "$postgres_container_image_id" = "$expected_postgres_image_id" ] || return 1
}
assert_source_helper_image_binding() {
  assert_source_engine_binding || return 1
  helper_repo_digests="$(source_docker image inspect "$BACKUP_HELPER_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}')" || return 1
  printf '%s\n' "$helper_repo_digests" | grep -F -x "$BACKUP_HELPER_IMAGE" >/dev/null || return 1
}
dispose_plaintext_workspace() {
  [ "$#" -eq 2 ] || return 1
  [ ! -L "$1" ] || return 1
  disposition_workspace="$(readlink -f -- "$1")" || return 1
  [ "$disposition_workspace" = "$2" ] || return 1
  [ -d "$disposition_workspace" ] || return 1
  [ "$disposition_workspace" != / ] && [ "$disposition_workspace" != "$(pwd -P)" ] || return 1
  [ "$(stat -c '%u' -- "$disposition_workspace")" = "$(id -u)" ] || return 1
  [ "$(stat -c '%a' -- "$disposition_workspace")" = 700 ] || return 1
  "$PLAINTEXT_DISPOSITION_COMMAND" dispose "$disposition_workspace" || return 1
}
canonicalize_backup_output() {
  expected_header=$1
  output=$2
  normalized_output="$(printf '%s\n' "$output" | tr -d '\r')" || return 1
  first_line="$(printf '%s\n' "$normalized_output" | sed -n '1p')" || return 1
  [ "$first_line" = "$expected_header" ] || return 1
  printf '%s\n' "$normalized_output"
}
cleanup_container_dump() {
  [ "$container_dump_created" -eq 0 ] && return 0
  assert_source_engine_binding || return 1
  compose_prod exec -T postgres rm -f /tmp/pale-orbit.dump || return 1
  container_dump_created=0
}
finish_source_backup() {
  prior_status=$1
  trap - EXIT
  finish_status=$prior_status
  cleanup_container_dump || finish_status=1
  if [ "$source_workspace_disposition_armed" -eq 1 ]; then
    dispose_plaintext_workspace "$backup" "$backup" || finish_status=1
    source_workspace_disposition_armed=0
  fi
  exit "$finish_status"
}
verify_source_storage_samples() {
  {
    IFS= read -r sample_header || return 1
    [ "$sample_header" = 'sample_kind,storage_key,checksum_sha256' ] || return 1
    while IFS=, read -r sample_kind storage_key expected_digest; do
      case "$sample_kind" in cover|revision_original|prose_image|comic_page|revision_cover_suggestion) ;; *) return 1 ;; esac
      case "$storage_key" in ''|/*|..|../*|*/../*|*/..) return 1 ;; esac
      printf '%s\n' "$expected_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
      assert_source_engine_binding || return 1
      digest_line="$(source_docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${project}_book_storage:/data:ro" "$BACKUP_HELPER_IMAGE" sha256sum -- "/data/$storage_key")" || return 1
      actual_digest=${digest_line%% *}
      printf '%s\n' "$actual_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
      [ "$actual_digest" = "$expected_digest" ] || return 1
    done
  } < "$backup/storage-samples.csv" || return 1
}

: "${COMPOSE_PROJECT_NAME:?explicit production Compose project is required}"
: "${APPROVED_SOURCE_DOCKER_CONTEXT:?approved source Docker context is required}"
: "${EXPECTED_SOURCE_DOCKER_ENGINE_ID:?expected source Docker engine ID is required}"
: "${APP_IMAGE:?exact application image is required}"
: "${POSTGRES_IMAGE:?exact PostgreSQL image is required}"
: "${BACKUP_HELPER_IMAGE:?exact backup helper image is required}"
: "${PLAINTEXT_DISPOSITION_COMMAND:?approved plaintext disposition wrapper is required}"
: "${BACKUP_SEAL_TRANSFER_COMMAND:?approved seal/transfer wrapper is required}"
: "${BACKUP_SOURCE_CIPHERTEXT:?source ciphertext path is required}"

project="$(normalize_compose_project "$COMPOSE_PROJECT_NAME")" || exit 1
source_docker_context=$APPROVED_SOURCE_DOCKER_CONTEXT
printf '%s\n' "$source_docker_context" | grep -Eq '^[A-Za-z0-9_.-]{1,128}$' || exit 1
production_docker_context=$source_docker_context
expected_source_docker_engine_id=$EXPECTED_SOURCE_DOCKER_ENGINE_ID
printf '%s\n' "$expected_source_docker_engine_id" | grep -Eq '^[A-Za-z0-9:_.-]{1,128}$' || exit 1
production_docker_engine_id=$expected_source_docker_engine_id
printf '%s\n' "$APP_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1
printf '%s\n' "$POSTGRES_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1
printf '%s\n' "$BACKUP_HELPER_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1
resolved_context="$(source_docker context inspect "$source_docker_context" --format '{{.Name}}')" || exit 1
[ "$resolved_context" = "$source_docker_context" ] || exit 1
assert_source_engine_binding || exit 1
assert_source_helper_image_binding || exit 1

backup="$(new_restricted_workspace "$(pwd -P)" 'backup-')" || exit 1
source_workspace_disposition_armed=1
trap 'finish_source_backup "$?"' EXIT
trap 'exit 1' HUP INT TERM
container_dump_created=0

assert_source_engine_binding || exit 1
compose_prod stop app worker || exit 1
assert_source_services_stopped || exit 1
assert_source_application_image_binding || exit 1
postgres="$(compose_prod ps -q postgres)" || exit 1
[ -n "$postgres" ] || exit 1
[ "$(printf '%s\n' "$postgres" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] || exit 1
assert_source_postgres_image_binding "$postgres" || exit 1

container_dump_created=1
assert_source_engine_binding || exit 1
compose_prod exec -T postgres pg_dump -U "$DATABASE_USER" -d "$DATABASE_NAME" --format=custom --file=/tmp/pale-orbit.dump || exit 1
assert_source_engine_binding || exit 1
source_docker cp "${postgres}:/tmp/pale-orbit.dump" "$backup/database.dump" || exit 1
cleanup_container_dump || exit 1

migration_journal="$(compose_prod exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 -U "$DATABASE_USER" -d "$DATABASE_NAME" -c 'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with (format csv, header true)')" || exit 1
canonicalize_backup_output 'id,hash,created_at' "$migration_journal" > "$backup/migration-journal.csv" || exit 1
row_counts="$(compose_prod exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U "$DATABASE_USER" -d "$DATABASE_NAME" < scripts/capture-restore-row-counts.sql)" || exit 1
canonicalize_backup_output 'schema_name,table_name,row_count' "$row_counts" > "$backup/restore-row-counts.csv" || exit 1
storage_samples="$(compose_prod exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U "$DATABASE_USER" -d "$DATABASE_NAME" < scripts/capture-storage-samples.sql)" || exit 1
canonicalize_backup_output 'sample_kind,storage_key,checksum_sha256' "$storage_samples" > "$backup/storage-samples.csv" || exit 1

cp -- scripts/verify-financial-restore.sql "$backup/verify-financial-restore.sql" || exit 1
# verify-financial-restore.sql is executed by psql with ON_ERROR_STOP from the authenticated backup copy.
compose_prod exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U "$DATABASE_USER" -d "$DATABASE_NAME" < "$backup/verify-financial-restore.sql" || exit 1
assert_source_engine_binding || exit 1
: > "$backup/storage.tar.gz" || exit 1
source_docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${project}_book_storage:/source:ro" -v "${backup}/storage.tar.gz:/output/storage.tar.gz" "$BACKUP_HELPER_IMAGE" tar -C /source -czf /output/storage.tar.gz . || exit 1
verify_source_storage_samples || exit 1
assert_source_services_stopped || exit 1

application_image_json="$(source_docker image inspect "$APP_IMAGE" --format '{{json .RepoDigests}}')" || exit 1
[ -n "$application_image_json" ] && [ "$application_image_json" != null ] && [ "$application_image_json" != '[]' ] || exit 1
repo_digests="$(source_docker image inspect "$APP_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}')" || exit 1
repo_digest_count=0
app_image_present=0
application_record='{"APP_IMAGE":"'"$APP_IMAGE"'","POSTGRES_IMAGE":"'"$POSTGRES_IMAGE"'","BACKUP_HELPER_IMAGE":"'"$BACKUP_HELPER_IMAGE"'","RepoDigests":['
separator=
while IFS= read -r repo_digest; do
  [ -n "$repo_digest" ] || continue
  printf '%s\n' "$repo_digest" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1
  [ "$repo_digest" = "$APP_IMAGE" ] && app_image_present=1
  application_record="$application_record$separator\"$repo_digest\""
  separator=,
  repo_digest_count=$((repo_digest_count + 1))
done <<EOF
$repo_digests
EOF
[ "$repo_digest_count" -ge 1 ] || exit 1
[ "$app_image_present" -eq 1 ] || exit 1
application_record="$application_record]}"
printf '%s\n' "$application_record" > "$backup/application-image.json" || exit 1
printf '{"docker_context":"%s","docker_engine_id":"%s"}\n' "$source_docker_context" "$expected_source_docker_engine_id" > "$backup/source-docker-engine.json" || exit 1

required_backup_files='database.dump
storage.tar.gz
migration-journal.csv
application-image.json
restore-row-counts.csv
storage-samples.csv
source-docker-engine.json
verify-financial-restore.sql'
source_entries="$(find "$backup" -mindepth 1 -maxdepth 1 -printf '%f\n')" || exit 1
[ "$(printf '%s\n' "$source_entries" | sort)" = "$(printf '%s\n' "$required_backup_files" | sort)" ] || exit 1
: > "$backup/backup-file-manifest.sha256" || exit 1
for name in $required_backup_files; do
  path="$backup/$name"
  [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] || exit 1
  digest_line="$(sha256sum -- "$path")" || exit 1
  actual_digest=${digest_line%% *}
  printf '%s\n' "$actual_digest" | grep -Eq '^[0-9a-f]{64}$' || exit 1
  printf '%s *%s\n' "$actual_digest" "$name" >> "$backup/backup-file-manifest.sha256" || exit 1
done

assert_source_services_stopped || exit 1
assert_source_engine_binding || exit 1
"$BACKUP_SEAL_TRANSFER_COMMAND" seal-transfer "$backup" "$BACKUP_SOURCE_CIPHERTEXT" || exit 1
source_ciphertext_digest_line="$(sha256sum -- "$BACKUP_SOURCE_CIPHERTEXT")" || exit 1
source_ciphertext_sha256=${source_ciphertext_digest_line%% *}
printf '%s\n' "$source_ciphertext_sha256" | grep -Eq '^[0-9a-f]{64}$' || exit 1
printf 'BACKUP_SOURCE_CIPHERTEXT_SHA256=%s\n' "$source_ciphertext_sha256"
exit 0
```

The two platform blocks are alternatives. They authenticate exactly eight required plaintext files plus `backup-file-manifest.sha256`. `restore-row-counts.csv` is a complete C-ordered inventory of every ordinary or partitioned base table in `public` and `drizzle`; it is not a handpicked table list. `storage-samples.csv` is deterministic and contains only storage keys and SHA-256 checksums. Both source verifiers run while app and worker are stopped and print neither credential hashes nor reset epochs. The source session deliberately provides no restart command.

## Integrity sampling

Use approved authenticated-encryption tooling to produce one authenticated encrypted artifact containing the eight required files and their manifest. On the isolated restore host, retrieve the exact transferred ciphertext, hash the retrieved destination file, and test-decrypt that destination file into a new restricted workspace. Reuse the exact `New-RestrictedWorkspace`/`Invoke-PlaintextDisposition` definitions above on Windows and the exact `new_restricted_workspace`/`dispose_plaintext_workspace` definitions above on GNU/Linux. The retrieval and test-decrypt wrappers are deployment-audited commands; their interfaces are shown below.

```powershell
$ErrorActionPreference = 'Stop'
function Assert-NativeSuccess {
  param([Parameter(Mandatory)][string]$Operation)
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed with native exit code $LASTEXITCODE" }
}
function New-RestrictedWorkspace {
  param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Prefix)
  $resolvedParent = (Resolve-Path -LiteralPath $Parent -ErrorAction Stop).Path
  $parentItem = Get-Item -LiteralPath $resolvedParent -Force -ErrorAction Stop
  if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Workspace parent must be a resolved non-reparse directory'
  }
  $workspace = Join-Path $resolvedParent ($Prefix + [guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $workspace -ErrorAction Stop
  $workspace = (Resolve-Path -LiteralPath $workspace -ErrorAction Stop).Path
  $item = Get-Item -LiteralPath $workspace -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Workspace must be a resolved non-reparse directory'
  }
  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $null = & icacls.exe $workspace /setowner $currentIdentity
  Assert-NativeSuccess 'set restricted workspace owner'
  $null = & icacls.exe $workspace /inheritance:r
  Assert-NativeSuccess 'remove inherited workspace access'
  $null = & icacls.exe $workspace /grant:r "${currentIdentity}:(OI)(CI)F"
  Assert-NativeSuccess 'grant current operator workspace access'
  $acl = Get-Acl -LiteralPath $workspace -ErrorAction Stop
  $foreignAllow = @($acl.Access | Where-Object {
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    $_.IdentityReference.Value -ne $currentIdentity
  })
  if (-not $acl.AreAccessRulesProtected -or $acl.Owner -ne $currentIdentity -or $foreignAllow.Count -ne 0) {
    throw 'Restricted workspace ACL validation failed'
  }
  if (@(Get-ChildItem -LiteralPath $workspace -Force -ErrorAction Stop).Count -ne 0) {
    throw 'Restricted workspace is not empty'
  }
  return $workspace
}
function Invoke-PlaintextDisposition {
  param([Parameter(Mandatory)][string]$Workspace)
  $resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
  $item = Get-Item -LiteralPath $resolvedWorkspace -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Disposition target must be a resolved non-reparse directory'
  }
  & $env:PLAINTEXT_DISPOSITION_COMMAND dispose $resolvedWorkspace
  Assert-NativeSuccess 'apply approved plaintext disposition'
}
function Invoke-VerifiedRestoreSession {
param([Parameter(Mandatory)][scriptblock]$RestoreAction)
foreach ($requiredVariable in @(
  'BACKUP_SOURCE_CIPHERTEXT_SHA256', 'BACKUP_DESTINATION_CIPHERTEXT',
  'BACKUP_RETRIEVE_COMMAND', 'BACKUP_TEST_DECRYPT_COMMAND',
  'PLAINTEXT_DISPOSITION_COMMAND'
)) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($requiredVariable))) {
    throw "$requiredVariable is required"
  }
}
$sourceCiphertextSha256 = $env:BACKUP_SOURCE_CIPHERTEXT_SHA256.Trim().ToLowerInvariant()
if ($sourceCiphertextSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Source ciphertext SHA-256 is invalid' }
$destinationCiphertext = [System.IO.Path]::GetFullPath($env:BACKUP_DESTINATION_CIPHERTEXT)
& $env:BACKUP_RETRIEVE_COMMAND retrieve $destinationCiphertext
Assert-NativeSuccess 'retrieve destination ciphertext'
$destinationCiphertextHash = (Get-FileHash -LiteralPath $destinationCiphertext -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
if ($destinationCiphertextHash -notmatch '^[0-9a-f]{64}$') { throw 'Destination ciphertext SHA-256 is invalid' }
if ($destinationCiphertextHash -ne $sourceCiphertextSha256) { throw 'Destination ciphertext differs from source ciphertext' }

$verifiedRestore = New-RestrictedWorkspace -Parent $PWD -Prefix 'verified-restore-'
$verifiedWorkspaceDispositionArmed = $true
try {
  & $env:BACKUP_TEST_DECRYPT_COMMAND test-decrypt $destinationCiphertext $verifiedRestore
  Assert-NativeSuccess 'test-decrypt exact destination ciphertext'

  $requiredBackupFiles = @(
    'database.dump'
    'storage.tar.gz'
    'migration-journal.csv'
    'application-image.json'
    'restore-row-counts.csv'
    'storage-samples.csv'
    'source-docker-engine.json'
    'verify-financial-restore.sql'
  )
  $manifestName = 'backup-file-manifest.sha256'
  $verifiedEntries = @(Get-ChildItem -LiteralPath $verifiedRestore -Force -ErrorAction Stop)
  $unsafeEntries = @($verifiedEntries | Where-Object {
    $_.PSIsContainer -or ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  })
  if ($unsafeEntries.Count -ne 0) { throw 'Verified restore contains a directory or reparse point' }
  $actualNames = @($verifiedEntries.Name | Sort-Object)
  $expectedNames = @(($requiredBackupFiles + $manifestName) | Sort-Object)
  if (@(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $actualNames).Count -ne 0) {
    throw 'Verified restore file inventory mismatch'
  }

  $verifiedManifestLines = foreach ($name in $requiredBackupFiles) {
    $path = Join-Path $verifiedRestore $name
    $requiredItem = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($requiredItem.Length -le 0) { throw "Verified restore file is empty: $name" }
    $actualDigest = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($actualDigest -notmatch '^[0-9a-f]{64}$') { throw "Verified SHA-256 is invalid: $name" }
    "$actualDigest *$name"
  }
  $recordedManifestPath = Join-Path $verifiedRestore $manifestName
  $recordedManifestItem = Get-Item -LiteralPath $recordedManifestPath -Force -ErrorAction Stop
  if ($recordedManifestItem.Length -le 0) { throw 'Verified restore manifest is empty' }
  $recordedManifestLines = @(Get-Content -LiteralPath $recordedManifestPath -ErrorAction Stop)
  if ($recordedManifestLines.Count -ne $requiredBackupFiles.Count -or
      @($recordedManifestLines | Where-Object { $_ -notmatch '^[0-9a-f]{64} \*[^/\\]+$' }).Count -ne 0 -or
      @(Compare-Object -ReferenceObject ($recordedManifestLines | Sort-Object) -DifferenceObject ($verifiedManifestLines | Sort-Object)).Count -ne 0) {
    throw 'Verified restore manifest mismatch, duplicate, or unsafe row'
  }
  & $RestoreAction $verifiedRestore
} finally {
  if ($verifiedWorkspaceDispositionArmed) {
    Invoke-PlaintextDisposition $verifiedRestore
    $verifiedWorkspaceDispositionArmed = $false
  }
}
}
```

On GNU/Linux, install the verification disposition trap before decrypting. `find` output is captured and its exit status checked before inventory emptiness or exact-name checks:

```sh
set -eu
umask 077
export LC_ALL=C

new_restricted_workspace() {
  parent="$(readlink -f -- "$1")" || return 1
  prefix=$2
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  workspace="$(mktemp -d --tmpdir="$parent" "${prefix}XXXXXXXX")" || return 1
  workspace="$(readlink -f -- "$workspace")" || return 1
  [ -d "$workspace" ] && [ ! -L "$workspace" ] || return 1
  [ "$(stat -c '%u' -- "$workspace")" = "$(id -u)" ] || return 1
  chmod 700 -- "$workspace" || return 1
  [ "$(stat -c '%a' -- "$workspace")" = 700 ] || return 1
  workspace_entries="$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
  [ -z "$workspace_entries" ] || return 1
  printf '%s\n' "$workspace"
}
dispose_plaintext_workspace() {
  [ "$#" -eq 2 ] || return 1
  [ ! -L "$1" ] || return 1
  disposition_workspace="$(readlink -f -- "$1")" || return 1
  [ "$disposition_workspace" = "$2" ] || return 1
  [ -d "$disposition_workspace" ] || return 1
  [ "$disposition_workspace" != / ] && [ "$disposition_workspace" != "$(pwd -P)" ] || return 1
  [ "$(stat -c '%u' -- "$disposition_workspace")" = "$(id -u)" ] || return 1
  [ "$(stat -c '%a' -- "$disposition_workspace")" = 700 ] || return 1
  "$PLAINTEXT_DISPOSITION_COMMAND" dispose "$disposition_workspace" || return 1
}

: "${BACKUP_SOURCE_CIPHERTEXT_SHA256:?source ciphertext SHA-256 is required}"
: "${BACKUP_DESTINATION_CIPHERTEXT:?destination ciphertext path is required}"
: "${BACKUP_RETRIEVE_COMMAND:?retrieval wrapper is required}"
: "${BACKUP_TEST_DECRYPT_COMMAND:?test-decrypt wrapper is required}"
: "${PLAINTEXT_DISPOSITION_COMMAND:?plaintext disposition wrapper is required}"

printf '%s\n' "$BACKUP_SOURCE_CIPHERTEXT_SHA256" | grep -Eq '^[0-9a-f]{64}$' || exit 1
destination_ciphertext=$BACKUP_DESTINATION_CIPHERTEXT
"$BACKUP_RETRIEVE_COMMAND" retrieve "$destination_ciphertext" || exit 1
destination_digest_line="$(sha256sum -- "$destination_ciphertext")" || exit 1
destination_ciphertext_hash=${destination_digest_line%% *}
printf '%s\n' "$destination_ciphertext_hash" | grep -Eq '^[0-9a-f]{64}$' || exit 1
[ "$destination_ciphertext_hash" = "$BACKUP_SOURCE_CIPHERTEXT_SHA256" ] || exit 1

verified_restore="$(new_restricted_workspace "$(pwd -P)" 'verified-restore-')" || exit 1
verified_workspace_disposition_armed=1
restore_project_started=0
restore_dump_present=0
finish_verified_restore() {
  prior_status=$1
  trap - EXIT
  finish_status=$prior_status
  if [ "$verified_workspace_disposition_armed" -eq 1 ]; then
    dispose_plaintext_workspace "$verified_restore" "$verified_restore" || finish_status=1
    verified_workspace_disposition_armed=0
  fi
  exit "$finish_status"
}
trap 'finish_verified_restore "$?"' EXIT
trap 'exit 1' HUP INT TERM

"$BACKUP_TEST_DECRYPT_COMMAND" test-decrypt "$destination_ciphertext" "$verified_restore" || exit 1

verify_plaintext_set() {
  plaintext_workspace=$1
  [ -d "$plaintext_workspace" ] && [ ! -L "$plaintext_workspace" ] || return 1
  required_backup_files='database.dump
storage.tar.gz
migration-journal.csv
application-image.json
restore-row-counts.csv
storage-samples.csv
source-docker-engine.json
verify-financial-restore.sql'
  verified_entries="$(find "$plaintext_workspace" -mindepth 1 -maxdepth 1 -printf '%f\n')" || return 1
  entry_count=0
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in
      database.dump|storage.tar.gz|migration-journal.csv|application-image.json|restore-row-counts.csv|storage-samples.csv|source-docker-engine.json|verify-financial-restore.sql|backup-file-manifest.sha256) ;;
      *) return 1 ;;
    esac
    entry_count=$((entry_count + 1))
  done <<EOF
$verified_entries
EOF
  [ "$entry_count" -eq 9 ] || return 1

  manifest="$plaintext_workspace/backup-file-manifest.sha256"
  [ -f "$manifest" ] && [ ! -L "$manifest" ] && [ -s "$manifest" ] || return 1
  recorded_manifest="$(tr -d '\r' < "$manifest")" || return 1
  [ "$(printf '%s\n' "$recorded_manifest" | awk 'NF { count++ } END { print count + 0 }')" -eq 8 ] || return 1
  verified_manifest=
  for name in $required_backup_files; do
    path="$plaintext_workspace/$name"
    [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] || return 1
    digest_line="$(sha256sum -- "$path")" || return 1
    actual_digest=${digest_line%% *}
    printf '%s\n' "$actual_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
    expected_line="$actual_digest *$name"
    [ "$(printf '%s\n' "$recorded_manifest" | grep -F -x -c "$expected_line")" -eq 1 ] || return 1
    verified_manifest="$verified_manifest$expected_line
"
  done
  [ "$(printf '%s' "$verified_manifest" | sort)" = "$(printf '%s\n' "$recorded_manifest" | sort)" ] || return 1
}
verify_plaintext_set "$verified_restore" || exit 1
```

A header check or source-side authentication is insufficient: every plaintext byte above comes from the exact retrieved destination ciphertext. The original source workspace is disposed by its source-session trap and is never a rehearsal input. Restriction is not encryption; on Windows the verified plaintext is created only inside `Invoke-VerifiedRestoreSession`, whose synchronous outer `finally` spans verification, rehearsal, teardown, and disposition; on GNU/Linux the armed disposition trap provides the same span. Every native encryption, transfer, retrieval, and test-decryption failure rejects the backup; do not accept an unauthenticated listing. The artifact and every verification plaintext remain subject to the approved securely delete or access-controlled retention policy.

## Isolated restore rehearsal

Never restore over production first. The isolated host requires a separately approved Docker context and engine ID, and that engine ID must differ from the authenticated production engine record. The exact `APP_IMAGE`, `POSTGRES_IMAGE`, and `BACKUP_HELPER_IMAGE` digests must match the authenticated application-image record and inspect successfully on the bound restore engine before any container or volume is created. The rehearsal sets the Compose default network to internal before PostgreSQL starts, so none of these containers receives an egress-capable network.

On Windows PowerShell, invoke the verified-session wrapper defined above. It creates and verifies the plaintext only after this synchronous callback starts, and its outer `finally` disposes the workspace after the callback's restore teardown succeeds or fails:

```powershell
Invoke-VerifiedRestoreSession {
param([Parameter(Mandatory)][string]$verifiedRestore)
$ErrorActionPreference = 'Stop'
$restoreProjectStarted = $false
$restoreDumpPresent = $false
$rehearsalSucceeded = $false
$cleanupErrors = [System.Collections.Generic.List[System.Exception]]::new()
try {
foreach ($requiredVariable in @(
  'APPROVED_RESTORE_DOCKER_CONTEXT', 'EXPECTED_RESTORE_DOCKER_ENGINE_ID',
  'APP_IMAGE', 'POSTGRES_IMAGE', 'BACKUP_HELPER_IMAGE'
)) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($requiredVariable))) {
    throw "$requiredVariable is required"
  }
}
$restoreDockerContext = $env:APPROVED_RESTORE_DOCKER_CONTEXT.Trim()
if ($restoreDockerContext -notmatch '^[A-Za-z0-9_.-]{1,128}$') { throw 'Approved restore Docker context is invalid' }
$expectedRestoreDockerEngineId = $env:EXPECTED_RESTORE_DOCKER_ENGINE_ID.Trim()
if ($expectedRestoreDockerEngineId -notmatch '^[A-Za-z0-9:_.-]{1,128}$') { throw 'Expected restore Docker engine ID is invalid' }
if ($env:APP_IMAGE -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') { throw 'APP_IMAGE must be an exact repository digest' }
if ($env:POSTGRES_IMAGE -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') {
  throw 'POSTGRES_IMAGE must be an exact repository digest'
}
if ($env:BACKUP_HELPER_IMAGE -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$') {
  throw 'BACKUP_HELPER_IMAGE must be an exact repository digest'
}

function New-RehearsalSecret {
  $bytes = New-Object byte[] 32
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  $secret = -join @($bytes | ForEach-Object { $_.ToString('x2') })
  if ($secret -notmatch '^[0-9a-f]{64}$') { throw 'Failed to generate a rehearsal-only secret' }
  return $secret
}

# Do not import the production .env file. Compose interpolation receives only
# synthetic rehearsal values, and SMTP is deliberately confined to container loopback.
$env:DATABASE_NAME = 'restore_rehearsal'
$env:DATABASE_USER = 'restore_rehearsal'
$env:DATABASE_PASSWORD = New-RehearsalSecret
$env:AUTH_SECRET = New-RehearsalSecret
$env:SMTP_PASSWORD = New-RehearsalSecret
$env:BOOTSTRAP_ADMIN_PASSWORD = New-RehearsalSecret
$env:ORIGIN = 'https://restore.invalid'
$env:SITE_ADDRESS = 'restore.invalid'
$env:SMTP_HOST = '127.0.0.1'
$env:SMTP_PORT = '1'
$env:SMTP_SECURE = 'false'
$env:SMTP_REQUIRE_TLS = 'false'
$env:SMTP_USER = 'restore-rehearsal'
$env:SMTP_FROM = 'Restore Rehearsal <noreply@restore.invalid>'
$env:BOOTSTRAP_ADMIN_EMAIL = 'restore-admin@restore.invalid'
$env:BOOTSTRAP_ADMIN_NAME = 'Restore Rehearsal'
$env:HTTP_BIND_ADDRESS = '127.0.0.1'
$env:HTTPS_BIND_ADDRESS = '127.0.0.1'
$env:COMPOSE_DEFAULT_NETWORK_INTERNAL = 'true'
Remove-Item -Path Env:STRIPE_SECRET_KEY, Env:STRIPE_WEBHOOK_SECRET,
  Env:STRIPE_SECRET_KEY_FILE, Env:STRIPE_WEBHOOK_SECRET_FILE -ErrorAction SilentlyContinue

function Assert-RehearsalEnvironment {
  foreach ($secretName in @('DATABASE_PASSWORD', 'AUTH_SECRET', 'SMTP_PASSWORD', 'BOOTSTRAP_ADMIN_PASSWORD')) {
    if ([Environment]::GetEnvironmentVariable($secretName) -notmatch '^[0-9a-f]{64}$') {
      throw "$secretName is not a synthetic rehearsal secret"
    }
  }
  if ($env:DATABASE_NAME -ne 'restore_rehearsal' -or
      $env:DATABASE_USER -ne 'restore_rehearsal' -or
      $env:ORIGIN -ne 'https://restore.invalid' -or
      $env:SITE_ADDRESS -ne 'restore.invalid' -or
      $env:SMTP_HOST -ne '127.0.0.1' -or
      $env:SMTP_PORT -ne '1' -or
      $env:SMTP_SECURE -ne 'false' -or
      $env:SMTP_REQUIRE_TLS -ne 'false' -or
      $env:HTTP_BIND_ADDRESS -ne '127.0.0.1' -or
      $env:HTTPS_BIND_ADDRESS -ne '127.0.0.1' -or
      $env:COMPOSE_DEFAULT_NETWORK_INTERNAL -ne 'true' -or
      $env:STRIPE_SECRET_KEY -or $env:STRIPE_WEBHOOK_SECRET -or
      $env:STRIPE_SECRET_KEY_FILE -or $env:STRIPE_WEBHOOK_SECRET_FILE) {
    throw 'The isolated rehearsal environment is not synthetic and non-routable'
  }
}
Assert-RehearsalEnvironment

function ConvertTo-CanonicalBackupText {
  param(
    [Parameter(Mandatory)][object[]]$Lines,
    [Parameter(Mandatory)][string]$Header
  )
  $normalized = (($Lines | ForEach-Object { [string]$_ }) -join [Environment]::NewLine).Replace([char]13, '')
  $normalizedLines = @($normalized -split [char]10)
  if ($normalizedLines.Count -lt 1 -or $normalizedLines[0] -ne $Header) {
    throw "Canonical restore output has the wrong header: $Header"
  }
  return ($normalizedLines -join [char]10) + [char]10
}
function Assert-RestoreDockerEngineBinding {
  $observedRestoreEngine = @(& docker --context $restoreDockerContext info --format '{{.ID}}')
  Assert-NativeSuccess 'read approved restore Docker engine ID'
  if ($observedRestoreEngine.Count -ne 1 -or $observedRestoreEngine[0].Trim() -ne $expectedRestoreDockerEngineId) {
    throw 'Approved restore Docker engine ID does not match'
  }
}
function Assert-RestoreImageBinding {
  $imageRecord = Get-Content -LiteralPath (Join-Path $verifiedRestore 'application-image.json') -Raw -ErrorAction Stop |
    ConvertFrom-Json -ErrorAction Stop
  if (-not ($imageRecord.RepoDigests -is [System.Array])) {
    throw 'Authenticated application image RepoDigests must be an array'
  }
  $recordedRepoDigests = @($imageRecord.RepoDigests)
  if ($imageRecord.APP_IMAGE -ne $env:APP_IMAGE -or
      $imageRecord.POSTGRES_IMAGE -ne $env:POSTGRES_IMAGE -or
      $imageRecord.BACKUP_HELPER_IMAGE -ne $env:BACKUP_HELPER_IMAGE -or
      $recordedRepoDigests.Count -lt 1 -or
      @($recordedRepoDigests | Where-Object { $_ -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$' }).Count -ne 0 -or
      $recordedRepoDigests -notcontains $env:APP_IMAGE) {
    throw 'Authenticated application image binding is invalid'
  }
  $restoreRepoDigestJson = @(& docker --context $restoreDockerContext image inspect $env:APP_IMAGE --format '{{json .RepoDigests}}')
  Assert-NativeSuccess 'inspect bound restore application image'
  if ($restoreRepoDigestJson.Count -ne 1 -or [string]::IsNullOrWhiteSpace($restoreRepoDigestJson[0])) {
    throw 'Restore RepoDigests output is ambiguous'
  }
  $restoreRepoDigestJsonText = $restoreRepoDigestJson[0].Trim()
  if (-not ($restoreRepoDigestJsonText.StartsWith('[') -and $restoreRepoDigestJsonText.EndsWith(']'))) {
    throw 'Restore engine RepoDigests must be a JSON array'
  }
  $restoreRepoDigests = @($restoreRepoDigestJsonText | ConvertFrom-Json -ErrorAction Stop)
  if ($restoreRepoDigests.Count -lt 1 -or
      @($restoreRepoDigests | Where-Object { $_ -notmatch '^[^@\s]+@sha256:[0-9a-f]{64}$' }).Count -ne 0 -or
      $restoreRepoDigests -notcontains $env:APP_IMAGE) {
    throw 'Restore engine lacks exact APP_IMAGE RepoDigest'
  }
  $restoreHelperRepoDigests = @(& docker --context $restoreDockerContext image inspect $env:BACKUP_HELPER_IMAGE --format '{{range .RepoDigests}}{{println .}}{{end}}')
  Assert-NativeSuccess 'inspect bound restore backup helper image'
  if ($restoreHelperRepoDigests -notcontains $env:BACKUP_HELPER_IMAGE) {
    throw 'Restore engine lacks exact BACKUP_HELPER_IMAGE RepoDigest'
  }
  $restorePostgresRepoDigests = @(& docker --context $restoreDockerContext image inspect $env:POSTGRES_IMAGE --format '{{range .RepoDigests}}{{println .}}{{end}}')
  Assert-NativeSuccess 'inspect bound restore PostgreSQL image'
  if ($restorePostgresRepoDigests -notcontains $env:POSTGRES_IMAGE) {
    throw 'Restore engine lacks exact POSTGRES_IMAGE RepoDigest'
  }
}
function Get-RestoreProjectInventory {
  $containers = @(& docker --context $restoreDockerContext container ls --all --quiet --filter $projectLabel)
  Assert-NativeSuccess 'inventory restore containers'
  $networks = @(& docker --context $restoreDockerContext network ls --quiet --filter $projectNameFilter)
  Assert-NativeSuccess 'inventory restore networks'
  $volumes = @(& docker --context $restoreDockerContext volume ls --quiet --filter $projectNameFilter)
  Assert-NativeSuccess 'inventory restore volumes'
  [pscustomobject]@{
    Containers = $containers
    Networks = $networks
    Volumes = $volumes
    TotalCount = $containers.Count + $networks.Count + $volumes.Count
  }
}
function Assert-RestoreProjectAbsent {
  param([Parameter(Mandatory)]$Inventory)
  if ($Inventory.TotalCount -ne 0) { throw 'Restore project resources are present' }
}
function Assert-RestoreWorkerStopped {
  $runningRestoreWorkers = @(& docker --context $restoreDockerContext container ls --quiet --filter $projectLabel --filter 'label=com.docker.compose.service=worker')
  Assert-NativeSuccess 'inspect restore worker state'
  if ($runningRestoreWorkers.Count -ne 0) { throw 'Restore worker must remain stopped' }
}
function Invoke-RestoreSql {
  param([Parameter(Mandatory)][string]$Sql)
  $output = @($Sql | & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U $env:DATABASE_USER -d $env:DATABASE_NAME)
  Assert-NativeSuccess 'execute isolated restore SQL'
  return $output
}
function Assert-RestoreMigrationJournal {
  $journal = @(& docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 -U $env:DATABASE_USER -d $env:DATABASE_NAME -c 'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with (format csv, header true)')
  Assert-NativeSuccess 'capture restored migration journal'
  $actual = ConvertTo-CanonicalBackupText -Lines $journal -Header 'id,hash,created_at'
  $expected = (Get-Content -LiteralPath (Join-Path $verifiedRestore 'migration-journal.csv') -Raw -ErrorAction Stop).Replace([char]13, '')
  if ($actual -ne $expected) { throw 'Restored migration journal differs from authenticated source' }
}
function Assert-RestoreRowCounts {
  $sql = Get-Content -LiteralPath 'scripts/capture-restore-row-counts.sql' -Raw -ErrorAction Stop
  $actual = ConvertTo-CanonicalBackupText -Lines (Invoke-RestoreSql $sql) -Header 'schema_name,table_name,row_count'
  $expected = (Get-Content -LiteralPath (Join-Path $verifiedRestore 'restore-row-counts.csv') -Raw -ErrorAction Stop).Replace([char]13, '')
  if ($actual -ne $expected) { throw 'Restored complete row-count inventory differs from authenticated source' }
}
function Assert-RestoredStorageSamples {
  $rows = @(Import-Csv -LiteralPath (Join-Path $verifiedRestore 'storage-samples.csv') -ErrorAction Stop)
  foreach ($row in $rows) {
    if ($row.sample_kind -notin @('cover', 'revision_original', 'prose_image', 'comic_page', 'revision_cover_suggestion') -or
        [string]::IsNullOrWhiteSpace($row.storage_key) -or
        $row.storage_key -match '(^/|(^|/)\.\.(/|$))' -or
        $row.checksum_sha256 -notmatch '^[0-9a-f]{64}$') {
      throw 'Authenticated restored storage sample is unsafe or malformed'
    }
    Assert-RestoreDockerEngineBinding
    $digestOutput = @(& docker --context $restoreDockerContext run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${restoreProject}_book_storage:/data:ro" $env:BACKUP_HELPER_IMAGE sha256sum -- "/data/$($row.storage_key)")
    Assert-NativeSuccess 'hash restored storage sample'
    if ($digestOutput.Count -ne 1) { throw 'Restored storage digest output is ambiguous' }
    $actualDigest = (($digestOutput[0] -split '\s+')[0]).ToLowerInvariant()
    if ($actualDigest -notmatch '^[0-9a-f]{64}$' -or $actualDigest -ne $row.checksum_sha256) {
      throw 'Restored storage sample differs from authenticated source'
    }
  }
}
function Invoke-FinancialRestoreVerifier {
  $verifiedSqlPath = Join-Path $verifiedRestore 'verify-financial-restore.sql'
  $verifiedSql = Get-Content -LiteralPath $verifiedSqlPath -Raw -ErrorAction Stop
  $null = Invoke-RestoreSql $verifiedSql
}

Assert-RestoreDockerEngineBinding
$sourceEngineRecord = Get-Content -LiteralPath (Join-Path $verifiedRestore 'source-docker-engine.json') -Raw -ErrorAction Stop |
  ConvertFrom-Json -ErrorAction Stop
if ($sourceEngineRecord.docker_context -notmatch '^[A-Za-z0-9_.-]{1,128}$' -or
    $sourceEngineRecord.docker_engine_id -notmatch '^[A-Za-z0-9:_.-]{1,128}$') {
  throw 'Authenticated source Docker engine record is invalid'
}
if ($expectedRestoreDockerEngineId -eq $sourceEngineRecord.docker_engine_id) {
  throw 'Restore engine must differ from source production engine'
}
Assert-RestoreImageBinding

$restoreProject = 'pale-orbit-restore-' + [guid]::NewGuid().ToString('N')
$projectLabel = "label=com.docker.compose.project=$restoreProject"
$projectNameFilter = "name=${restoreProject}_"
  $preflightInventory = Get-RestoreProjectInventory
  Assert-RestoreProjectAbsent $preflightInventory
  Assert-RestoreWorkerStopped
  $restoreProjectStarted = $true
  Assert-RestoreDockerEngineBinding
  Assert-RehearsalEnvironment
  Assert-RestoreWorkerStopped
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml up --detach --wait postgres
  Assert-NativeSuccess 'start isolated restore PostgreSQL'
  Assert-RestoreWorkerStopped

  $restorePostgresIds = @(& docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml ps -q postgres)
  Assert-NativeSuccess 'locate isolated restore PostgreSQL container'
  if ($restorePostgresIds.Count -ne 1 -or [string]::IsNullOrWhiteSpace($restorePostgresIds[0])) {
    throw 'Expected exactly one isolated restore PostgreSQL container'
  }
  $restorePostgres = $restorePostgresIds[0].Trim()
  $restoreDumpPresent = $true
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext cp (Join-Path $verifiedRestore 'database.dump') "${restorePostgres}:/tmp/database.dump"
  Assert-NativeSuccess 'copy verified database dump into isolated restore'
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml exec -T postgres pg_restore -U $env:DATABASE_USER -d $env:DATABASE_NAME --clean --if-exists --no-owner /tmp/database.dump
  Assert-NativeSuccess 'restore verified PostgreSQL dump'
  Assert-RestoreWorkerStopped

  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml create app
  Assert-NativeSuccess 'create isolated app container and storage volume without starting app'
  Assert-RestoreWorkerStopped
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges -v "${restoreProject}_book_storage:/restore" -v "$(Join-Path $verifiedRestore 'storage.tar.gz'):/backup/storage.tar.gz:ro" $env:BACKUP_HELPER_IMAGE tar -C /restore -xzf /backup/storage.tar.gz
  Assert-NativeSuccess 'restore verified private storage archive'
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${restoreProject}_book_storage:/restore:ro" $env:BACKUP_HELPER_IMAGE sh -eu -c 'unsafe="$(find /restore -xdev ! -type d ! -type f -print -quit)" || exit 1; test -z "$unsafe"'
  Assert-NativeSuccess 'reject unsafe restored storage entry types'
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml --profile tools run --rm migrate
  Assert-NativeSuccess 'run committed migrations in isolated restore'
  Assert-RestoreWorkerStopped

  Assert-RestoreMigrationJournal
  Assert-RestoreRowCounts
  Assert-RestoredStorageSamples
  Invoke-FinancialRestoreVerifier
  Assert-RestoreWorkerStopped
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml --profile tools run --rm storage-cleanup
  Assert-NativeSuccess 'run isolated storage cleanup dry-run'
  Assert-RestoreWorkerStopped

  Assert-RestoreDockerEngineBinding
  Assert-RehearsalEnvironment
  Assert-RestoreWorkerStopped
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml up --detach --wait app
  Assert-NativeSuccess 'start isolated maintenance app'
  Assert-RestoreWorkerStopped
  Assert-RestoreDockerEngineBinding
  & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml exec -T app node -e "Promise.all(['/health/live','/health/ready'].map((path)=>fetch('http://127.0.0.1:3000'+path).then((response)=>{if(!response.ok)throw new Error(path)}))).catch(()=>process.exit(1))"
  Assert-NativeSuccess 'probe isolated maintenance health endpoints'
  Assert-RestoreWorkerStopped
  $rehearsalSucceeded = $true
} finally {
  if ($restoreProjectStarted) {
    if ($restoreDumpPresent) {
      try {
        Assert-RestoreDockerEngineBinding
        & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml exec -T postgres rm -f /tmp/database.dump
        Assert-NativeSuccess 'remove isolated restore container dump'
        $restoreDumpPresent = $false
      } catch {
        $cleanupErrors.Add($_.Exception)
      }
    }
    try {
      $preTeardownInventory = Get-RestoreProjectInventory
      if ($preTeardownInventory.TotalCount -eq 0) { throw 'Restore project disappeared before controlled teardown' }
    } catch {
      $cleanupErrors.Add($_.Exception)
    }
    try {
      Assert-RestoreDockerEngineBinding
      & docker --context $restoreDockerContext compose --project-name $restoreProject --file compose.prod.yaml down --volumes
      Assert-NativeSuccess 'destroy isolated restore project'
    } catch {
      $cleanupErrors.Add($_.Exception)
    }
    try {
      $postTeardownInventory = Get-RestoreProjectInventory
      Assert-RestoreProjectAbsent $postTeardownInventory
      $restoreProjectStarted = $false
    } catch {
      $cleanupErrors.Add($_.Exception)
    }
  }
  if ($cleanupErrors.Count -ne 0) {
    throw [System.AggregateException]::new('Restore cleanup or plaintext disposition failed', $cleanupErrors)
  }
}
if (-not $rehearsalSucceeded) { throw 'Isolated restore rehearsal failed' }
}
```

On GNU/Linux, continue in the shell whose verification trap is already armed. This redefines the same trap target so any later failure revalidates the restore engine, removes a possibly copied container dump, destroys only the generated project, proves absence, and disposes all verification plaintext:

```sh
: "${APPROVED_RESTORE_DOCKER_CONTEXT:?approved restore Docker context is required}"
: "${EXPECTED_RESTORE_DOCKER_ENGINE_ID:?expected restore Docker engine ID is required}"
: "${APP_IMAGE:?exact application image is required}"
: "${POSTGRES_IMAGE:?exact PostgreSQL image is required}"
: "${BACKUP_HELPER_IMAGE:?exact backup helper image is required}"

restore_docker_context=$APPROVED_RESTORE_DOCKER_CONTEXT
printf '%s\n' "$restore_docker_context" | grep -Eq '^[A-Za-z0-9_.-]{1,128}$' || exit 1
expected_restore_docker_engine_id=$EXPECTED_RESTORE_DOCKER_ENGINE_ID
printf '%s\n' "$expected_restore_docker_engine_id" | grep -Eq '^[A-Za-z0-9:_.-]{1,128}$' || exit 1
printf '%s\n' "$APP_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1
printf '%s\n' "$POSTGRES_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1
printf '%s\n' "$BACKUP_HELPER_IMAGE" | grep -Eq '^[^[:space:]@]+@sha256:[0-9a-f]{64}$' || exit 1

new_rehearsal_secret() {
  secret_bytes="$(od -An -N32 -tx1 /dev/urandom)" || return 1
  secret_hex="$(printf '%s' "$secret_bytes" | tr -d ' \n')" || return 1
  printf '%s\n' "$secret_hex" | grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s\n' "$secret_hex"
}

# Do not source the production .env file. These are synthetic rehearsal-only
# values, and SMTP can reach only loopback inside the maintenance app container.
DATABASE_NAME=restore_rehearsal
DATABASE_USER=restore_rehearsal
DATABASE_PASSWORD="$(new_rehearsal_secret)" || exit 1
AUTH_SECRET="$(new_rehearsal_secret)" || exit 1
SMTP_PASSWORD="$(new_rehearsal_secret)" || exit 1
BOOTSTRAP_ADMIN_PASSWORD="$(new_rehearsal_secret)" || exit 1
export DATABASE_NAME DATABASE_USER
export DATABASE_PASSWORD
export AUTH_SECRET
export SMTP_PASSWORD
export BOOTSTRAP_ADMIN_PASSWORD
ORIGIN=https://restore.invalid
SITE_ADDRESS=restore.invalid
SMTP_HOST=127.0.0.1
SMTP_PORT=1
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_USER=restore-rehearsal
SMTP_FROM='Restore Rehearsal <noreply@restore.invalid>'
BOOTSTRAP_ADMIN_EMAIL=restore-admin@restore.invalid
BOOTSTRAP_ADMIN_NAME='Restore Rehearsal'
HTTP_BIND_ADDRESS=127.0.0.1
HTTPS_BIND_ADDRESS=127.0.0.1
COMPOSE_DEFAULT_NETWORK_INTERNAL=true
export ORIGIN SITE_ADDRESS SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_REQUIRE_TLS SMTP_USER SMTP_FROM
export BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_NAME HTTP_BIND_ADDRESS HTTPS_BIND_ADDRESS
export COMPOSE_DEFAULT_NETWORK_INTERNAL
unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_SECRET_KEY_FILE STRIPE_WEBHOOK_SECRET_FILE

assert_rehearsal_environment() {
  for secret_value in "$DATABASE_PASSWORD" "$AUTH_SECRET" "$SMTP_PASSWORD" "$BOOTSTRAP_ADMIN_PASSWORD"; do
    printf '%s\n' "$secret_value" | grep -Eq '^[0-9a-f]{64}$' || return 1
  done
  [ "$DATABASE_NAME" = restore_rehearsal ] || return 1
  [ "$DATABASE_USER" = restore_rehearsal ] || return 1
  [ "$ORIGIN" = https://restore.invalid ] || return 1
  [ "$SITE_ADDRESS" = restore.invalid ] || return 1
  [ "$SMTP_HOST" = 127.0.0.1 ] || return 1
  [ "$SMTP_PORT" = 1 ] || return 1
  [ "$SMTP_SECURE" = false ] || return 1
  [ "$SMTP_REQUIRE_TLS" = false ] || return 1
  [ "$HTTP_BIND_ADDRESS" = 127.0.0.1 ] || return 1
  [ "$HTTPS_BIND_ADDRESS" = 127.0.0.1 ] || return 1
  [ "$COMPOSE_DEFAULT_NETWORK_INTERNAL" = true ] || return 1
  [ -z "${STRIPE_SECRET_KEY:-}${STRIPE_WEBHOOK_SECRET:-}${STRIPE_SECRET_KEY_FILE:-}${STRIPE_WEBHOOK_SECRET_FILE:-}" ] || return 1
}
assert_rehearsal_environment || exit 1

restore_docker() {
  docker --context "$restore_docker_context" "$@"
}
compose_restore() {
  restore_docker compose --project-name "$restore_project" --file compose.prod.yaml "$@"
}
assert_restore_engine_binding() {
  observed_restore_engine="$(restore_docker info --format '{{.ID}}')" || return 1
  [ "$observed_restore_engine" = "$expected_restore_docker_engine_id" ] || return 1
}
get_restore_project_inventory() {
  restore_containers="$(restore_docker container ls --all --quiet --filter "$project_label")" || return 1
  restore_networks="$(restore_docker network ls --quiet --filter "$project_name_filter")" || return 1
  restore_volumes="$(restore_docker volume ls --quiet --filter "$project_name_filter")" || return 1
  printf '%s\n%s\n%s\n' "$restore_containers" "$restore_networks" "$restore_volumes" | awk 'NF'
}
assert_restore_project_absent() {
  [ "$#" -eq 1 ] || return 1
  [ -z "$1" ] || return 1
}
assert_restore_worker_stopped() {
  running_restore_workers="$(restore_docker container ls --quiet --filter "$project_label" --filter 'label=com.docker.compose.service=worker')" || return 1
  [ -z "$running_restore_workers" ] || return 1
}
assert_restore_image_binding() {
  application_record="$(tr -d '\r\n' < "$verified_restore/application-image.json")" || return 1
  printf '%s\n' "$application_record" | grep -Eq '^\{"APP_IMAGE":"[^"@[:space:]]+@sha256:[0-9a-f]{64}","POSTGRES_IMAGE":"[^"@[:space:]]+@sha256:[0-9a-f]{64}","BACKUP_HELPER_IMAGE":"[^"@[:space:]]+@sha256:[0-9a-f]{64}","RepoDigests":\["[^"@[:space:]]+@sha256:[0-9a-f]{64}"(,"[^"@[:space:]]+@sha256:[0-9a-f]{64}")*\]\}$' || return 1
  recorded_app_image="$(printf '%s\n' "$application_record" | sed -n 's/^{"APP_IMAGE":"\([^"]*\)".*$/\1/p')" || return 1
  [ "$recorded_app_image" = "$APP_IMAGE" ] || return 1
  recorded_postgres_image="$(printf '%s\n' "$application_record" | sed -n 's/^.*"POSTGRES_IMAGE":"\([^"]*\)".*$/\1/p')" || return 1
  [ "$recorded_postgres_image" = "$POSTGRES_IMAGE" ] || return 1
  recorded_helper_image="$(printf '%s\n' "$application_record" | sed -n 's/^.*"BACKUP_HELPER_IMAGE":"\([^"]*\)".*$/\1/p')" || return 1
  [ "$recorded_helper_image" = "$BACKUP_HELPER_IMAGE" ] || return 1
  recorded_repo_digest_lines="$(printf '%s\n' "$application_record" | sed -e 's/^.*"RepoDigests":\[//' -e 's/\]}$//' | tr ',' '\n' | tr -d '"')" || return 1
  printf '%s\n' "$recorded_repo_digest_lines" | grep -F -x "$APP_IMAGE" >/dev/null || return 1
  restore_repo_digests="$(restore_docker image inspect "$APP_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}')" || return 1
  printf '%s\n' "$restore_repo_digests" | grep -F -x "$APP_IMAGE" >/dev/null || return 1
  restore_helper_repo_digests="$(restore_docker image inspect "$BACKUP_HELPER_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}')" || return 1
  printf '%s\n' "$restore_helper_repo_digests" | grep -F -x "$BACKUP_HELPER_IMAGE" >/dev/null || return 1
  restore_postgres_repo_digests="$(restore_docker image inspect "$POSTGRES_IMAGE" --format '{{range .RepoDigests}}{{println .}}{{end}}')" || return 1
  printf '%s\n' "$restore_postgres_repo_digests" | grep -F -x "$POSTGRES_IMAGE" >/dev/null || return 1
}
compare_migration_journal() {
  restored_journal="$(compose_restore exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 -U "$DATABASE_USER" -d "$DATABASE_NAME" -c 'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with (format csv, header true)')" || return 1
  expected_journal="$(tr -d '\r' < "$verified_restore/migration-journal.csv")" || return 1
  [ "$(printf '%s\n' "$restored_journal" | tr -d '\r')" = "$expected_journal" ] || return 1
}
compare_restore_row_counts() {
  restored_counts="$(compose_restore exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U "$DATABASE_USER" -d "$DATABASE_NAME" < scripts/capture-restore-row-counts.sql)" || return 1
  expected_counts="$(tr -d '\r' < "$verified_restore/restore-row-counts.csv")" || return 1
  [ "$(printf '%s\n' "$restored_counts" | tr -d '\r')" = "$expected_counts" ] || return 1
}
verify_restored_storage_samples() {
  {
    IFS= read -r sample_header || return 1
    [ "$sample_header" = 'sample_kind,storage_key,checksum_sha256' ] || return 1
    while IFS=, read -r sample_kind storage_key expected_digest; do
      case "$sample_kind" in cover|revision_original|prose_image|comic_page|revision_cover_suggestion) ;; *) return 1 ;; esac
      case "$storage_key" in ''|/*|..|../*|*/../*|*/..) return 1 ;; esac
      printf '%s\n' "$expected_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
      assert_restore_engine_binding || return 1
      digest_line="$(restore_docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${restore_project}_book_storage:/data:ro" "$BACKUP_HELPER_IMAGE" sha256sum -- "/data/$storage_key")" || return 1
      actual_digest=${digest_line%% *}
      printf '%s\n' "$actual_digest" | grep -Eq '^[0-9a-f]{64}$' || return 1
      [ "$actual_digest" = "$expected_digest" ] || return 1
    done
  } < "$verified_restore/storage-samples.csv" || return 1
}
run_financial_restore_verifier() {
  compose_restore exec -T postgres psql -X --no-psqlrc --set ON_ERROR_STOP=1 --quiet -U "$DATABASE_USER" -d "$DATABASE_NAME" < "$verified_restore/verify-financial-restore.sql" || return 1
}
cleanup_restore_dump() {
  [ "$restore_dump_present" -eq 0 ] && return 0
  assert_restore_engine_binding || return 1
  compose_restore exec -T postgres rm -f /tmp/database.dump || return 1
  restore_dump_present=0
}
finish_verified_restore() {
  prior_status=$1
  trap - EXIT
  finish_status=$prior_status
  if [ "$restore_project_started" -eq 1 ]; then
    if assert_restore_engine_binding; then
      cleanup_restore_dump || finish_status=1
      if assert_restore_engine_binding; then
        compose_restore down --volumes || finish_status=1
      else
        finish_status=1
      fi
      post_failure_inventory="$(get_restore_project_inventory)" || finish_status=1
      assert_restore_project_absent "$post_failure_inventory" || finish_status=1
    else
      finish_status=1
    fi
    restore_project_started=0
  fi
  if [ "$verified_workspace_disposition_armed" -eq 1 ]; then
    dispose_plaintext_workspace "$verified_restore" "$verified_restore" || finish_status=1
    verified_workspace_disposition_armed=0
  fi
  exit "$finish_status"
}

assert_restore_engine_binding || exit 1
source_engine_record="$(tr -d '\r\n' < "$verified_restore/source-docker-engine.json")" || exit 1
printf '%s\n' "$source_engine_record" | grep -Eq '^\{"docker_context":"[A-Za-z0-9_.-]{1,128}","docker_engine_id":"[A-Za-z0-9:_.-]{1,128}"\}$' || exit 1
source_production_engine_id="$(printf '%s\n' "$source_engine_record" | sed -n 's/.*"docker_engine_id":"\([^"]*\)".*/\1/p')" || exit 1
[ "$expected_restore_docker_engine_id" != "$source_production_engine_id" ] || exit 1
assert_restore_image_binding || exit 1

restore_id="$(tr -d '-' < /proc/sys/kernel/random/uuid)" || exit 1
printf '%s\n' "$restore_id" | grep -Eq '^[0-9a-f]{32}$' || exit 1
restore_project="pale-orbit-restore-$restore_id"
project_label="label=com.docker.compose.project=$restore_project"
project_name_filter="name=${restore_project}_"
restore_project_started=0
restore_dump_present=0

preflight_inventory="$(get_restore_project_inventory)" || exit 1
assert_restore_project_absent "$preflight_inventory" || exit 1
assert_restore_worker_stopped || exit 1
restore_project_started=1
assert_restore_engine_binding || exit 1
assert_rehearsal_environment || exit 1
assert_restore_worker_stopped || exit 1
compose_restore up --detach --wait postgres || exit 1
assert_restore_worker_stopped || exit 1

restore_postgres="$(compose_restore ps -q postgres)" || exit 1
[ -n "$restore_postgres" ] || exit 1
[ "$(printf '%s\n' "$restore_postgres" | awk 'NF { count++ } END { print count + 0 }')" -eq 1 ] || exit 1
restore_dump_present=1
assert_restore_engine_binding || exit 1
restore_docker cp "$verified_restore/database.dump" "${restore_postgres}:/tmp/database.dump" || exit 1
assert_restore_engine_binding || exit 1
compose_restore exec -T postgres pg_restore -U "$DATABASE_USER" -d "$DATABASE_NAME" --clean --if-exists --no-owner /tmp/database.dump || exit 1
assert_restore_worker_stopped || exit 1

assert_restore_engine_binding || exit 1
compose_restore create app || exit 1
assert_restore_worker_stopped || exit 1
assert_restore_engine_binding || exit 1
restore_docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges -v "${restore_project}_book_storage:/restore" -v "${verified_restore}/storage.tar.gz:/backup/storage.tar.gz:ro" "$BACKUP_HELPER_IMAGE" tar -C /restore -xzf /backup/storage.tar.gz || exit 1
assert_restore_engine_binding || exit 1
restore_docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges -v "${restore_project}_book_storage:/restore:ro" "$BACKUP_HELPER_IMAGE" sh -eu -c 'unsafe="$(find /restore -xdev ! -type d ! -type f -print -quit)" || exit 1; test -z "$unsafe"' || exit 1
assert_restore_engine_binding || exit 1
compose_restore --profile tools run --rm migrate || exit 1
assert_restore_worker_stopped || exit 1

compare_migration_journal || exit 1
compare_restore_row_counts || exit 1
verify_restored_storage_samples || exit 1
run_financial_restore_verifier || exit 1
assert_restore_worker_stopped || exit 1
assert_restore_engine_binding || exit 1
compose_restore --profile tools run --rm storage-cleanup || exit 1
assert_restore_worker_stopped || exit 1

assert_restore_engine_binding || exit 1
assert_rehearsal_environment || exit 1
assert_restore_worker_stopped || exit 1
compose_restore up --detach --wait app || exit 1
assert_restore_worker_stopped || exit 1
assert_restore_engine_binding || exit 1
compose_restore exec -T app node -e "Promise.all(['/health/live','/health/ready'].map((path)=>fetch('http://127.0.0.1:3000'+path).then((response)=>{if(!response.ok)throw new Error(path)}))).catch(()=>process.exit(1))" || exit 1
assert_restore_worker_stopped || exit 1

pre_teardown_inventory="$(get_restore_project_inventory)" || exit 1
[ -n "$pre_teardown_inventory" ] || exit 1
assert_restore_engine_binding || exit 1
cleanup_restore_dump || exit 1
assert_restore_engine_binding || exit 1
compose_restore down --volumes || exit 1
post_teardown_inventory="$(get_restore_project_inventory)" || exit 1
assert_restore_project_absent "$post_teardown_inventory" || exit 1
restore_project_started=0
dispose_plaintext_workspace "$verified_restore" "$verified_restore" || exit 1
verified_workspace_disposition_armed=0
trap - EXIT HUP INT TERM
```

Keep the general worker stopped for the entire isolated restore rehearsal. Provider absence is not sufficient isolation: the same general worker can claim local-only claim-email and SMTP outbox jobs, including `commerce.claim-email` and `commerce.claim-email-request`. Maintenance mode admits only `/health/live` and `/health/ready`; UI authentication, administrator pages, and reader rendering are unavailable and are not rehearsal evidence. Do not exercise mail-producing workflows. No production SMTP or provider credential may be present in the restore-host session: start from a sanitized session, do not import the production `.env`, retain the synthetic values above, and treat any environment assertion failure as a failed rehearsal.

Before teardown, inventory the generated project's containers, network, and database/storage volumes. The verification plaintext inventory is exactly `database.dump`, `storage.tar.gz`, `migration-journal.csv`, `application-image.json`, `restore-row-counts.csv`, `storage-samples.csv`, `source-docker-engine.json`, `verify-financial-restore.sql`, and `backup-file-manifest.sha256` under `$verifiedRestore`/`$verified_restore`, plus the temporary container copy `/tmp/database.dump`. Every verification artifact is covered: every file under `$verifiedRestore` and every file under `$verified_restore` is subject to the same policy. The finally/trap path revalidates the approved restore engine before mutation, uses `down --volumes` only for the generated project, proves post-teardown absence, and applies the approved secure-deletion or access-controlled-retention policy to every file. Copy-on-write filesystems, SSDs, snapshots, and Docker storage can make overwriting unreliable; securely delete through encrypted-volume/key-destruction policy where required.

Starting a worker belongs only to a separately approved production replacement after destination verification. A future rehearsal could include a worker only with an explicitly implemented and approved no-egress rehearsal runtime, synthetic SMTP, and job-family allowlist; this repository does not currently supply that runtime. This runbook intentionally provides no production restart command and never reuses the isolated restore Docker session.

## Future provider migration

Migrate through the `ObjectStorage` interface: build and test an S3-compatible adapter, copy objects while preserving opaque keys and checksums, verify every database-referenced object, switch the provider in a maintenance window, and retain the local volume until rollback expires. Do not add an AWS SDK merely to prepare for that future migration.
