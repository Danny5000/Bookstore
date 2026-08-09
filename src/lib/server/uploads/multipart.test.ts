import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parsePublicationUpload, UploadError } from './multipart';

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
