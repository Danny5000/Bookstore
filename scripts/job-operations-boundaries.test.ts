import { access, readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8');
}

async function sourceFiles(directory: URL, prefix: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(new URL(`${entry.name}/`, directory), path));
    } else if (/\.(?:ts|svelte)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function imports(value: string): readonly string[] {
  return Array.from(value.matchAll(/from\s+['"](?<path>[^'"]+)['"]/gu), (match) =>
    match.groups?.path ?? ''
  ).filter(Boolean);
}

describe('job operations application boundaries', () => {
  it('keeps contracts independent of database, worker, provider, route, and browser modules', async () => {
    const contracts = await source('src/lib/server/operations/jobs/contracts.ts');

    expect(imports(contracts).some((path) =>
      /(?:db|worker|stripe|provider|routes|browser|\$app|\$env)/u.test(path)
    )).toBe(false);
  });

  it('keeps the repository on exactly three complete routines and off protected tables', async () => {
    const repository = await source('src/lib/server/operations/jobs/repository.ts');
    const routineCalls = Array.from(
      repository.matchAll(/public\.(?<routine>[a-z][a-z0-9_]*)\(/gu),
      (match) => match.groups?.routine ?? ''
    );

    expect(routineCalls).toEqual([
      'list_operational_jobs',
      'submit_job_retry_command',
      'get_owned_job_retry_command'
    ]);
    expect(repository).not.toMatch(/(?:from|into|update|join)\s+["']?(?:jobs|audit_events|operations_job_retry_(?:commands|claims))/iu);
    expect(imports(repository).some((path) => /db\/schema|jobs\/repository|audit\/service/u.test(path)))
      .toBe(false);
  });

  it('keeps the service on authorization, contracts, repository, and narrow audit only', async () => {
    const service = await source('src/lib/server/operations/jobs/service.ts');

    expect(imports(service).sort()).toEqual([
      '$lib/server/auth/admin-policy',
      './audit',
      './contracts',
      './repository'
    ].sort());
    expect(service).not.toMatch(/\b(?:sql|execute|select|insert|update|delete)\b/iu);
    expect(service).not.toMatch(/(?:fetch|stripe|provider|worker)/iu);
  });

  it('allows only audit.ts to import the shared audit service and freezes denial provenance', async () => {
    const directory = new URL('src/lib/server/operations/jobs/', root);
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith('.ts') && !name.endsWith('.test.ts')
    );
    const sharedAuditImporters: string[] = [];
    for (const file of files) {
      const value = await readFile(new URL(file, directory), 'utf8');
      if (value.includes('$lib/server/audit/service')) sharedAuditImporters.push(file);
    }
    expect(sharedAuditImporters).toEqual(['audit.ts']);

    const audit = await source('src/lib/server/operations/jobs/audit.ts');
    expect(audit).toContain("action: 'operations.job_retry.requested'");
    expect(audit).toContain("outcome: 'denied'");
    expect(audit).toContain("resourceType: 'operations_job_retry_command'");
    for (const field of ['resourceId', 'requestMetadata', 'before', 'after']) {
      expect(audit).toMatch(new RegExp(`${field}: null`, 'u'));
    }

    const service = await source('src/lib/server/operations/jobs/service.ts');
    expect(service).toContain('auditJobRetryRequestDenied');
    expect(service.match(/await auditDenied\(/gu)).toHaveLength(1);
  });

  it('adds no route, UI, navigation, polling, public API, or provider boundary', async () => {
    for (const path of [
      'src/routes/admin/jobs',
      'src/routes/admin/operations',
      'src/lib/components/job-operations',
      'src/lib/client/job-operations'
    ]) {
      await expect(access(new URL(path, root))).rejects.toThrow();
    }

    const applicationFiles = [
      ...await sourceFiles(new URL('src/routes/', root), 'src/routes'),
      ...await sourceFiles(new URL('src/lib/', root), 'src/lib')
    ];
    const unexpectedConsumers: string[] = [];
    for (const file of applicationFiles) {
      if (file.startsWith('src/lib/server/operations/jobs/')) continue;
      const value = await source(file);
      if (
        /(?:\$lib\/server\/operations\/jobs|server\/operations\/jobs)/u.test(value) ||
        /(?:href|action)\s*=\s*["']\/admin\/(?:jobs|operations)/u.test(value) ||
        /(?:Retry job|Job operations|pollJobRetryCommand)/u.test(value)
      ) unexpectedConsumers.push(file);
    }
    expect(unexpectedConsumers).toEqual([]);

    const operationsSources = await Promise.all(
      (await readdir(new URL('src/lib/server/operations/jobs/', root)))
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => source(`src/lib/server/operations/jobs/${name}`))
    );
    const combined = operationsSources.join('\n');
    expect(combined).not.toMatch(/(?:stripe|provider gateway|\bfetch\s*\(|src\/worker|from ['"].*worker)/iu);
    expect(combined).not.toMatch(/(?:polling|retry button|navigation link|public api)/iu);
  });
});
