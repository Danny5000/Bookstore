# Customer library, reader state, and original downloads

## Ownership and release boundary

PostgreSQL is authoritative for customer access and saved reader state. A user has an effective entitlement only when one `entitlements` row exists for the user/title pair and `revoked_at` is null. Plan 5 deliberately has no application grant or revoke route: the browser, library page, reader APIs, and admin catalog cannot create an entitlement. Plan 6 owns checkout, Stripe webhook reconciliation, guest-order claiming, and the audited grant/revoke service. Until that plan lands, test-only direct seeding lives only under `tests/e2e`.

Access is resolved on the server for every reader, media, and download request. The precedence is:

1. an administrator may review a specifically authorized draft or published presentation;
2. a customer with an active entitlement may use the current active revision and published presentation, even when the storefront title is private/withdrawn or archived;
3. everyone else may use only the reviewed preview of a public title;
4. a missing active revision/published presentation is unavailable, and every other case is denied.

Withdrawal or archival does not erase a paid entitlement or immutable original. The title remains on the entitled shelf and remains readable/downloadable while a valid current publication root exists. If that root is temporarily incomplete, the shelf shows an unavailable item without a dead link. Revocation immediately removes the shelf entry and makes full reader, private derived media, and original download requests fail closed. It does not change an independently public preview.

## Reader persistence and conflicts

Entitled readers store progress, bookmarks, account display preferences, and per-title comic mode on the server. Preview readers use a versioned local-storage envelope scoped to the title, revision, and published presentation; preview state never grants access and is never promoted to account state. Admin review uses memory-only persistence.

Progress is debounced for 750 ms and sent with an expected version. Account preferences and comic mode use the same optimistic version rule. A stale mutation returns `409` with the current safe state. The client adopts the authoritative location and announces the conflict instead of overwriting another device. Retryable transport or `503` failures use bounded 1, 2, and 4 second retries. Page-hide keepalive is best effort and is not reported as a confirmed save.

All saved locations are semantic: prose uses block ID plus visible-text offset; comics use page ID plus an optional panel ordinal. Reader controls jump to and persist the exact semantic target, including two-page desktop spreads. Status and edition messages use polite live regions. Dismissing an edition notice returns keyboard focus to the reader status target.

## Revision migration

New ingestion writes versioned SHA-256 semantic fingerprints on prose blocks and comic pages. Prose image fingerprints incorporate the normalized derived image checksum; comic fingerprints use normalized page pixels. Rows ingested before Plan 5 may have both fingerprint columns null. Nullable legacy rows are intentionally not guessed or backfilled during a read.

On first access to a new active revision, reader state is migrated once inside the same locked transaction. Only a unique, same-version exact fingerprint match is accepted. Progress moves to that match or resets to the beginning; bookmarks with no unique exact match remain unmatched instead of being approximated. Comic panel positions are retained only when the target presentation supports an exact valid panel; otherwise the page can be retained with the panel position simplified. The resulting `reader_revision_migrations` row drives one accessible notice until the customer acknowledges it.

The lock order is fixed: title advisory lock, user/title reader-state advisory lock, persisted user key-share lock, title row lock, then entitlement row lock and publication/state work. Account-wide preferences use their separate user preference advisory lock. New code must preserve this order.

## Private media and original downloads

The customer download URL contains only the title ID. The server re-resolves actor, entitlement, active revision, and published presentation on every `GET` or `HEAD`; it never trusts a revision or object key supplied by the browser. EPUB downloads use `application/epub+zip`; CBZ and ZIP use their safe archive media types. `Content-Disposition` uses a sanitized title-based filename, `ETag` is the immutable original checksum, `Accept-Ranges: bytes` is present, and a valid single range returns `206`. `HEAD` returns the same metadata without reading or returning a body. Invalid/multiple ranges return `416` with the object size.

Successful customer downloads append `library.original.download`. The event contains the actor, title/revision identifiers, request method/route, and whether a range was requested. It never contains storage keys, local paths, original filenames, cookies, authorization headers, tokens, or file bytes. A storage stat/read failure returns an error and must not be converted into a success or public URL.

Publication files are never email attachments and storage is never mounted into Caddy. No public or presigned object URLs are minted. Local disk is the implemented provider; `STORAGE_PROVIDER=s3` remains a fail-at-startup interface stub and no AWS SDK is installed.

## Backup and restore

The coordinated PostgreSQL dump and private-volume archive in [storage, ingestion, publication, and recovery](storage-ingestion-and-publication.md) are one backup unit. The database dump must include these six Plan 5 tables:

- `entitlements`
- `reader_progress`
- `reader_bookmarks`
- `reader_preferences`
- `reader_title_preferences`
- `reader_revision_migrations`

It must also include `semantic_fingerprint_sha256` and `semantic_fingerprint_version` on both `prose_blocks` and `comic_pages`. During an isolated restore, compare row counts for all six tables, verify the fingerprint pair is either both null or both populated, and sample reader state against restored active revisions before accepting the backup.

## Recovery diagnostics

- **Shelf item unavailable:** verify the entitlement is active, `titles.active_revision_id` points to an active revision, and that revision has exactly one published presentation. Do not hand-edit the shelf DTO or grant a replacement entitlement.
- **Migration failed or repeats:** check the active pointer, fingerprint pair constraints, the target migration row, and application logs by correlation ID. Preserve old state and upload/activate a corrected immutable revision if source content is wrong; do not fabricate approximate mappings.
- **Persistent stale conflict:** close duplicate tabs, reload to obtain the authoritative version, and confirm the reader-state endpoint can reach PostgreSQL. Never increment versions manually to silence a conflict.
- **Missing storage object:** compare the database checksum/size with the private volume and backup manifest. Restore the exact immutable object or activate a verified replacement revision; never expose the volume or substitute an unverified file.
- **Unexpected loss of access:** inspect the entitlement timestamps and relevant audit events without selecting auth or outbox secrets. A non-null `revoked_at` is authoritative. Plan 5 has no production re-grant control; defer remediation to the audited Plan 6 boundary.

Production remains fixed to `APPLICATION_MODE=maintenance` through Plan 5. Plan 6 must add commerce and grant/revoke reconciliation, complete its own release gates, and explicitly approve the storefront mode change; deploying this branch alone must not make production public.
