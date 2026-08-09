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
7. **Roll back** switches to a prior ready/retired revision and its published settings. **Withdraw** makes catalog, detail, and preview routes unavailable without deleting admin review or retained originals.

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

Monitor the Docker data filesystem with `Get-PSDrive`/`df -h` and the volume with a read-only helper such as `docker run --rm -v <project>_book_storage:/data:ro alpine:3.22 du -sh /data`. Alert at 75% filesystem use. At 85%, stop new uploads before continuing: announce the maintenance window and stop `app` if an upload-specific edge rule is unavailable, allow the worker to finish current work, run cleanup dry-run/apply, expand storage, and verify headroom before restarting. Do not let the filesystem reach 90%.

## Coordinated backup

Use a maintenance window so the database and volume represent the same point in application activity. Export the production variables from the secret/deployment system, create a restricted backup directory, and record the UTC timestamp. Then:

```powershell
$backup = Join-Path $PWD ("backup-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $backup | Out-Null
docker compose --file compose.prod.yaml stop app worker
$postgres = docker compose --file compose.prod.yaml ps -q postgres
docker compose --file compose.prod.yaml exec -T postgres pg_dump -U $env:DATABASE_USER -d $env:DATABASE_NAME --format=custom --file=/tmp/pale-orbit.dump
docker cp "${postgres}:/tmp/pale-orbit.dump" (Join-Path $backup 'database.dump')
docker compose --file compose.prod.yaml exec -T postgres rm -f /tmp/pale-orbit.dump
docker compose --file compose.prod.yaml exec -T postgres psql -U $env:DATABASE_USER -d $env:DATABASE_NAME -c 'copy (select * from drizzle.__drizzle_migrations order by id) to stdout with csv header' | Set-Content (Join-Path $backup 'migration-journal.csv')
```

Archive the named volume with the deployment's explicit Compose project name:

```powershell
$project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'bookstore' }
docker run --rm -v "${project}_book_storage:/source:ro" -v "${backup}:/backup" alpine:3.22 tar -C /source -czf /backup/storage.tar.gz .
docker image inspect $env:APP_IMAGE --format '{{json .RepoDigests}}' | Set-Content (Join-Path $backup 'application-image.json')
Get-FileHash (Join-Path $backup 'database.dump'), (Join-Path $backup 'storage.tar.gz') -Algorithm SHA256 | Format-Table -HideTableHeaders Path,Hash | Out-File (Join-Path $backup 'backup-sha256.txt')
docker compose --file compose.prod.yaml up --detach --wait app worker
```

Use an explicit `COMPOSE_PROJECT_NAME` in production so the volume name is stable. Encrypt and copy the backup set off the VPS. Copying `/var/lib/postgresql` from a running container is not an accepted backup: filesystem copies can capture torn or version-dependent database state. PostgreSQL logical `pg_dump`/`pg_restore` is the supported path.

## Integrity sampling

After backup, compare a sample of database checksums to the volume. Query several current covers and revision originals:

```powershell
docker compose --file compose.prod.yaml exec -T postgres psql -U $env:DATABASE_USER -d $env:DATABASE_NAME -c 'select cover_storage_key, cover_checksum_sha256 from titles where cover_storage_key is not null order by updated_at desc limit 5;'
docker compose --file compose.prod.yaml exec -T postgres psql -U $env:DATABASE_USER -d $env:DATABASE_NAME -c 'select original_storage_key, original_checksum_sha256 from title_revisions where original_storage_key is not null order by created_at desc limit 5;'
```

Hash those exact paths from a read-only volume helper with `sha256sum`. Also verify that each active title points to an active revision, that active revisions have one published presentation, and that sampled prose-image/comic-page/cover rows have corresponding objects. A backup is not considered valid until this sampling and an isolated restore succeed.

## Isolated restore rehearsal

Never restore over production first. Choose a unique project name and keep public ports closed:

```powershell
$restoreProject = 'pale-orbit-restore-check'
docker compose --project-name $restoreProject --file compose.prod.yaml up --detach --wait postgres
$restorePostgres = docker compose --project-name $restoreProject --file compose.prod.yaml ps -q postgres
docker cp (Join-Path $backup 'database.dump') "${restorePostgres}:/tmp/database.dump"
docker compose --project-name $restoreProject --file compose.prod.yaml exec -T postgres pg_restore -U $env:DATABASE_USER -d $env:DATABASE_NAME --clean --if-exists --no-owner /tmp/database.dump
docker run --rm -v "${restoreProject}_book_storage:/restore" -v "${backup}:/backup:ro" alpine:3.22 tar -C /restore -xzf /backup/storage.tar.gz
docker compose --project-name $restoreProject --file compose.prod.yaml --profile tools run --rm migrate
docker compose --project-name $restoreProject --file compose.prod.yaml --profile tools run --rm storage-cleanup
```

Compare the restored migration journal, row counts, active-revision/published-presentation pointers, retained-original and cover manifests, and SHA-256 samples. Start app and worker only on an isolated network, confirm `/health/ready`, admin review, and sampled previews, then destroy only the named restore project with `docker compose --project-name $restoreProject --file compose.prod.yaml down --volumes`. Production replacement requires a separately approved maintenance and rollback procedure.

## Future provider migration

Migrate through the `ObjectStorage` interface: build and test an S3-compatible adapter, copy objects while preserving opaque keys and checksums, verify every database-referenced object, switch the provider in a maintenance window, and retain the local volume until rollback expires. Do not add an AWS SDK merely to prepare for that future migration.
