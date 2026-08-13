import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parsePublicationUpload, UploadError } from './multipart';

const require = createRequire(import.meta.url);

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function formRequest(form: FormData, signal?: AbortSignal): Request {
  return new Request('http://localhost/admin/upload', {
    method: 'POST',
    body: form,
    ...(signal ? { signal } : {})
  });
}

describe('parsePublicationUpload', () => {
  it('loads the security-patched multipart parser pinned by the manifest and lockfile', () => {
    const installed = JSON.parse(
      readFileSync(require.resolve('@fastify/busboy/package.json'), 'utf8')
    ) as { version?: unknown };
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
    ) as { dependencies?: Record<string, unknown> };
    const lockfile = JSON.parse(
      readFileSync(new URL('../../../../package-lock.json', import.meta.url), 'utf8')
    ) as {
      packages?: Record<string, {
        dependencies?: Record<string, unknown>;
        version?: unknown;
      }>;
    };

    expect({
      declared: manifest.dependencies?.['@fastify/busboy'],
      installed: installed.version,
      lockDeclared: lockfile.packages?.['']?.dependencies?.['@fastify/busboy'],
      locked: lockfile.packages?.['node_modules/@fastify/busboy']?.version
    }).toEqual({
      declared: '3.2.1',
      installed: '3.2.1',
      lockDeclared: '3.2.1',
      locked: '3.2.1'
    });
  });

  it.each(['__proto__', 'constructor'])(
    'contains the %s part header inside the multipart parser process',
    (headerName) => {
      const boundary = 'pale-orbit-security-boundary';
      const operation = `parser.end(Buffer.from(
        '--' + boundary + '\\r\\n${headerName}: hostile\\r\\n' +
        'Content-Disposition: form-data; name="changeSummary"\\r\\n\\r\\n' +
        'value\\r\\n--' + boundary + '--\\r\\n'
      ));`;
      const script = `
      import Busboy from '@fastify/busboy';
      const boundary = ${JSON.stringify(boundary)};
      const parser = new Busboy({
        headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }
      });
      parser.on('file', (_field, stream) => stream.resume());
      parser.on('field', () => undefined);
      parser.once('error', () => process.exit(2));
      parser.once('finish', () => process.exit(0));
      ${operation}
    `;
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true
      });

      expect(child.error).toBeUndefined();
      expect({ status: child.status, signal: child.signal }).toEqual({
        status: 0,
        signal: null
      });
    }
  );

  it.each([
    ['unquoted', `multipart/form-data; boundary=${'a'.repeat(71)}`],
    ['quoted', `multipart/form-data; boundary="${'a'.repeat(71)}"`]
  ])('rejects an RFC-oversized %s boundary before parsing the body', async (_name, contentType) => {
    const request = new Request('http://localhost/admin/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });

    await expect(parsePublicationUpload(request, 100)).rejects.toMatchObject({
      code: 'malformed_multipart'
    });
    expect(request.bodyUsed).toBe(false);
  });

  it.each([
    [
      'extended',
      `multipart/form-data; boundary*=utf-8''${'a'.repeat(71)}; boundary=safe-boundary`
    ],
    [
      'whitespace-obscured',
      `multipart/form-data; b o u n d a r y=${'a'.repeat(71)}; boundary=safe-boundary`
    ]
  ])('rejects an ambiguous %s boundary before parsing the body', async (_name, contentType) => {
    const request = new Request('http://localhost/admin/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });

    await expect(parsePublicationUpload(request, 100)).rejects.toMatchObject({
      code: 'malformed_multipart'
    });
    expect(request.bodyUsed).toBe(false);
  });

  it.each([
    ['non-ASCII', `multipart/form-data; boundary="${'\u0080'.repeat(35)}"`],
    ['trailing-space', 'multipart/form-data; boundary="safe-boundary "'],
    ['non-HTTP whitespace', `multipart/form-data; boundary=\f${'a'.repeat(70)}`],
    ['quoted backslashes', `multipart/form-data; boundary="${'\\a'.repeat(70)}"`]
  ])('rejects an RFC-invalid %s boundary before parsing the body', async (_name, contentType) => {
    const request = new Request('http://localhost/admin/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });

    await expect(parsePublicationUpload(request, 100)).rejects.toMatchObject({
      code: 'malformed_multipart'
    });
    expect(request.bodyUsed).toBe(false);
  });

  it('accepts a valid multipart upload with a 70-byte boundary', async () => {
    const boundary = 'a'.repeat(70);
    const request = new Request('http://localhost/admin/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: [
        `--${boundary}\r\nContent-Disposition: form-data; name="changeSummary"\r\n\r\nTest\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="original"; filename="book.epub"\r\n`,
        'Content-Type: application/epub+zip\r\n\r\ncontent\r\n',
        `--${boundary}--\r\n`
      ].join(''),
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });

    const parsed = await parsePublicationUpload(request, 100);
    await expect(collect(parsed.file)).resolves.toBe('content');
    await expect(parsed.completion).resolves.toBeUndefined();
  });

  it('streams exactly one original plus strict publication fields', async () => {
    const form = new FormData();
    form.append('changeSummary', 'Corrected chapter spacing');
    form.append('parentRevisionId', '018f0000-0000-7000-8000-000000000011');
    form.append('original', new Blob(['abcdef'], { type: 'application/epub+zip' }), 'book.epub');

    const parsed = await parsePublicationUpload(formRequest(form), 100);
    await expect(collect(parsed.file)).resolves.toBe('abcdef');
    await expect(parsed.completion).resolves.toBeUndefined();
    expect(parsed).toMatchObject({
      filename: 'book.epub',
      mediaType: 'application/epub+zip',
      changeSummary: 'Corrected chapter spacing',
      parentRevisionId: '018f0000-0000-7000-8000-000000000011'
    });
  });

  it('normalizes the filename to a bounded safe display leaf', async () => {
    const form = new FormData();
    form.append('changeSummary', 'New file');
    form.append('original', new Blob(['x']), `..\\folder/control-\u0001-${'a'.repeat(300)}.epub`);

    const parsed = await parsePublicationUpload(formRequest(form), 100);
    await collect(parsed.file);
    await parsed.completion;

    expect(parsed.filename).not.toContain('\\');
    expect(parsed.filename).not.toContain('\u0001');
    expect([...parsed.filename]).toHaveLength(255);
  });

  it.each([
    ['zero files', (() => {
      const form = new FormData();
      form.append('changeSummary', 'No file');
      return formRequest(form);
    })()],
    ['wrong file field', (() => {
      const form = new FormData();
      form.append('changeSummary', 'Wrong field');
      form.append('cover', new Blob(['x']), 'cover.png');
      return formRequest(form);
    })()]
  ])('rejects %s', async (_name, request) => {
    await expect(parsePublicationUpload(request, 100)).rejects.toBeInstanceOf(UploadError);
  });

  it('rejects two files while draining the rejected part', async () => {
    const form = new FormData();
    form.append('changeSummary', 'Two files');
    form.append('original', new Blob(['first']), 'first.epub');
    form.append('original', new Blob(['second']), 'second.epub');
    const parsed = await parsePublicationUpload(formRequest(form), 100);

    await collect(parsed.file);
    await expect(parsed.completion).rejects.toMatchObject({ code: 'file_count_limit' });
  });

  it('rejects file and total request byte limits', async () => {
    const form = new FormData();
    form.append('changeSummary', 'Large file');
    form.append('original', new Blob(['12345']), 'large.epub');
    const parsed = await parsePublicationUpload(formRequest(form), 4);

    await collect(parsed.file);
    await expect(parsed.completion).rejects.toMatchObject({ code: 'file_size_limit' });
  });

  it('rejects invalid, excessive, or duplicate fields', async () => {
    for (const form of [
      (() => {
        const value = new FormData();
        value.append('changeSummary', '   ');
        value.append('original', new Blob(['x']), 'book.epub');
        return value;
      })(),
      (() => {
        const value = new FormData();
        value.append('changeSummary', 'a'.repeat(4_001));
        value.append('original', new Blob(['x']), 'book.epub');
        return value;
      })(),
      (() => {
        const value = new FormData();
        value.append('changeSummary', 'first');
        value.append('changeSummary', 'second');
        value.append('original', new Blob(['x']), 'book.epub');
        return value;
      })()
    ]) {
      const parsed = await parsePublicationUpload(formRequest(form), 10);
      await collect(parsed.file);
      await expect(parsed.completion).rejects.toBeInstanceOf(UploadError);
    }
  });

  it('rejects a truncated multipart body and client abort', async () => {
    const boundary = 'pale-orbit-boundary';
    const truncated = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: Readable.toWeb(
        Readable.from([
          `--${boundary}\r\nContent-Disposition: form-data; name="changeSummary"\r\n\r\nTest\r\n`,
          `--${boundary}\r\nContent-Disposition: form-data; name="original"; filename="book.epub"\r\nContent-Type: application/epub+zip\r\n\r\npartial`
        ])
      ) as ReadableStream<Uint8Array>,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    const parsed = await parsePublicationUpload(truncated, 100);
    await expect(collect(parsed.file)).rejects.toThrow();
    await expect(parsed.completion).rejects.toMatchObject({ code: 'malformed_multipart' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      parsePublicationUpload(
        new Request('http://localhost/upload', {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>,
          duplex: 'half',
          signal: controller.signal
        } as RequestInit & { duplex: 'half' }),
        100
      )
    ).rejects.toMatchObject({ code: 'upload_aborted' });
  });
});
