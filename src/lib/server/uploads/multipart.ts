import { posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import Busboy, { type BusboyFileStream } from '@fastify/busboy';
import { z } from 'zod';

export type UploadFailureCode =
  | 'malformed_multipart'
  | 'upload_aborted'
  | 'request_size_limit'
  | 'file_size_limit'
  | 'file_count_limit'
  | 'field_count_limit'
  | 'part_count_limit'
  | 'invalid_file_field'
  | 'invalid_fields'
  | 'storage_failure';

export class UploadError extends Error {
  readonly status: 400 | 413 | 503;

  constructor(readonly code: UploadFailureCode, safeMessage: string) {
    super(safeMessage);
    this.name = 'UploadError';
    this.status = code === 'storage_failure' ? 503 : code.includes('size_limit') ? 413 : 400;
  }
}

export interface MultipartLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxFields: number;
  maxParts: number;
  maxFieldBytes: number;
  maxFieldNameBytes: number;
}

export interface ParsedSingleFileMultipart<TFields> {
  filename: string;
  mediaType: string;
  file: Readable;
  readonly fields: TFields;
  completion: Promise<void>;
}

export interface ParseSingleFileMultipartOptions<TFields> {
  fileField: string;
  fieldsSchema: z.ZodType<TFields>;
  limits: MultipartLimits;
}

export interface ParsedPublicationUpload {
  filename: string;
  mediaType: string;
  changeSummary: string;
  parentRevisionId: string | null;
  file: Readable;
  completion: Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withoutControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('');
}

function safeDisplayFilename(value: string): string {
  const normalized = value.normalize('NFC').replaceAll('\\', '/');
  const leaf = withoutControlCharacters(posix.basename(normalized)).trim();
  const bounded = [...leaf].slice(0, 255).join('');
  return bounded || 'upload.bin';
}

function uploadError(cause: unknown): UploadError {
  if (cause instanceof UploadError) return cause;
  return new UploadError('malformed_multipart', 'Multipart upload is malformed');
}

export async function parseSingleFileMultipart<TFields>(
  request: Request,
  options: ParseSingleFileMultipartOptions<TFields>
): Promise<ParsedSingleFileMultipart<TFields>> {
  if (request.signal.aborted) {
    throw new UploadError('upload_aborted', 'Upload was aborted');
  }
  if (!request.body) throw new UploadError('malformed_multipart', 'Multipart body is required');
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) {
    throw new UploadError('malformed_multipart', 'Multipart content type is required');
  }

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = new Busboy({
      headers: { 'content-type': contentType },
      limits: {
        files: options.limits.maxFiles,
        fields: options.limits.maxFields,
        parts: options.limits.maxParts,
        fileSize: options.limits.maxFileBytes,
        fieldSize: options.limits.maxFieldBytes,
        fieldNameSize: options.limits.maxFieldNameBytes
      }
    });
  } catch (cause: unknown) {
    throw uploadError(cause);
  }

  const ready = deferred<ParsedSingleFileMultipart<TFields>>();
  const completed = deferred<void>();
  void completed.promise.catch(() => undefined);
  const rawFields: Record<string, string> = {};
  let parsedFields: TFields | undefined;
  let activeFile: BusboyFileStream | undefined;
  let fileCount = 0;
  let failure: UploadError | undefined;
  let readyResolved = false;
  let finished = false;

  const recordFailure = (cause: UploadError): void => {
    failure ??= cause;
  };
  const rejectImmediately = (cause: unknown): void => {
    const safeCause = uploadError(cause);
    recordFailure(safeCause);
    activeFile?.destroy(safeCause);
    if (!readyResolved) ready.reject(safeCause);
    completed.reject(safeCause);
  };

  parser.on('field', (name, value, nameTruncated, valueTruncated) => {
    if (nameTruncated || valueTruncated || Object.hasOwn(rawFields, name)) {
      recordFailure(new UploadError('invalid_fields', 'Upload fields are invalid'));
      return;
    }
    rawFields[name] = value;
  });
  parser.on('file', (fieldName, stream, filename, _encoding, mediaType) => {
    fileCount += 1;
    if (fieldName !== options.fileField || fileCount > 1) {
      stream.resume();
      recordFailure(
        new UploadError(
          fieldName === options.fileField ? 'file_count_limit' : 'invalid_file_field',
          'Upload must contain exactly one expected file'
        )
      );
      return;
    }
    activeFile = stream;
    stream.once('limit', () =>
      recordFailure(new UploadError('file_size_limit', 'Uploaded file exceeds the size limit'))
    );
    stream.once('end', () => {
      if (stream.truncated) {
        recordFailure(new UploadError('file_size_limit', 'Uploaded file exceeds the size limit'));
      }
    });
    const result: ParsedSingleFileMultipart<TFields> = {
      filename: safeDisplayFilename(filename),
      mediaType: mediaType || 'application/octet-stream',
      file: stream,
      get fields() {
        if (parsedFields === undefined) {
          throw new UploadError('invalid_fields', 'Upload fields are not complete');
        }
        return parsedFields;
      },
      completion: completed.promise
    };
    readyResolved = true;
    ready.resolve(result);
  });
  parser.on('filesLimit', () =>
    recordFailure(new UploadError('file_count_limit', 'Upload contains too many files'))
  );
  parser.on('fieldsLimit', () =>
    recordFailure(new UploadError('field_count_limit', 'Upload contains too many fields'))
  );
  parser.on('partsLimit', () =>
    recordFailure(new UploadError('part_count_limit', 'Upload contains too many parts'))
  );
  parser.once('error', rejectImmediately);
  parser.once('finish', () => {
    finished = true;
    if (fileCount !== 1) {
      recordFailure(new UploadError('file_count_limit', 'Upload must contain exactly one file'));
    }
    const fieldsResult = options.fieldsSchema.safeParse(rawFields);
    if (!fieldsResult.success) {
      recordFailure(new UploadError('invalid_fields', 'Upload fields are invalid'));
    } else parsedFields = fieldsResult.data;
    request.signal.removeEventListener('abort', abort);
    if (failure) {
      if (!readyResolved) ready.reject(failure);
      completed.reject(failure);
    } else completed.resolve();
  });

  const source = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
  let totalBytes = 0;
  const counter = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += bytes.byteLength;
      if (totalBytes > options.limits.maxTotalBytes) {
        callback(new UploadError('request_size_limit', 'Upload request exceeds the size limit'));
      } else callback(null, bytes);
    }
  });
  const abort = () => {
    const cause = new UploadError('upload_aborted', 'Upload was aborted');
    source.destroy(cause);
    counter.destroy(cause);
    parser.destroy(cause);
    rejectImmediately(cause);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  source.once('error', (cause: unknown) => {
    if (!finished) {
      parser.destroy(cause as Error);
      rejectImmediately(cause);
    }
  });
  counter.once('error', (cause: unknown) => {
    source.destroy();
    parser.destroy(cause as Error);
    rejectImmediately(cause);
  });
  source.pipe(counter).pipe(parser);
  return ready.promise;
}

const publicationFieldsSchema = z
  .object({
    changeSummary: z.string().trim().min(1).max(2_000),
    parentRevisionId: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || null)
      .pipe(z.uuid().nullable())
  })
  .strict();

type PublicationFields = z.output<typeof publicationFieldsSchema>;

export async function parsePublicationUpload(
  request: Request,
  maxUploadBytes: number
): Promise<ParsedPublicationUpload> {
  const parsed = await parseSingleFileMultipart<PublicationFields>(request, {
    fileField: 'original',
    fieldsSchema: publicationFieldsSchema,
    limits: {
      maxFileBytes: maxUploadBytes,
      maxTotalBytes: maxUploadBytes + 65_536,
      maxFiles: 1,
      maxFields: 2,
      maxParts: 3,
      maxFieldBytes: 4_000,
      maxFieldNameBytes: 100
    }
  });
  return {
    filename: parsed.filename,
    mediaType: parsed.mediaType,
    file: parsed.file,
    get changeSummary() {
      return parsed.fields.changeSummary;
    },
    get parentRevisionId() {
      return parsed.fields.parentRevisionId;
    },
    completion: parsed.completion
  };
}
