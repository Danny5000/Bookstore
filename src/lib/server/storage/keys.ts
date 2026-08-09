declare const storageKeyBrand: unique symbol;

export type StorageKey = string & { readonly [storageKeyBrand]: true };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class StorageKeyError extends Error {
  constructor() {
    super('Invalid storage key');
    this.name = 'StorageKeyError';
  }
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw new StorageKeyError();
  return value;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function parseStorageKey(value: string): StorageKey {
  if (value.length === 0 || value.length > 500) throw new StorageKeyError();

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new StorageKeyError();
  }

  if (
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    containsControlCharacter(decoded) ||
    /^[a-zA-Z]:/u.test(decoded)
  ) {
    throw new StorageKeyError();
  }

  const segments = decoded.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new StorageKeyError();
  }

  return value as StorageKey;
}

export function stagingUploadsPrefix(): StorageKey {
  return parseStorageKey('staging/uploads');
}

export function stagingUploadKey(uploadId: string): StorageKey {
  return parseStorageKey(`staging/uploads/${requireUuid(uploadId)}`);
}

export function revisionOriginalKey(titleId: string, revisionId: string): StorageKey {
  return parseStorageKey(
    `titles/${requireUuid(titleId)}/revisions/${requireUuid(revisionId)}/original`
  );
}

export function revisionDerivedPrefix(titleId: string, revisionId: string): StorageKey {
  return parseStorageKey(
    `titles/${requireUuid(titleId)}/revisions/${requireUuid(revisionId)}/derived/v1`
  );
}

export function revisionProseImageKey(
  titleId: string,
  revisionId: string,
  imageId: string
): StorageKey {
  return parseStorageKey(
    `${revisionDerivedPrefix(titleId, revisionId)}/prose-images/${requireUuid(imageId)}.webp`
  );
}

export function revisionComicPageKey(
  titleId: string,
  revisionId: string,
  pageId: string
): StorageKey {
  return parseStorageKey(
    `${revisionDerivedPrefix(titleId, revisionId)}/comic-pages/${requireUuid(pageId)}.webp`
  );
}

export function revisionCoverSuggestionKey(
  titleId: string,
  revisionId: string,
  suggestionId: string
): StorageKey {
  return parseStorageKey(
    `${revisionDerivedPrefix(titleId, revisionId)}/cover-suggestions/${requireUuid(suggestionId)}.webp`
  );
}

export function titleCoversPrefix(titleId: string): StorageKey {
  return parseStorageKey(`titles/${requireUuid(titleId)}/covers`);
}

export function titleCoverKey(titleId: string, coverId: string): StorageKey {
  return parseStorageKey(`${titleCoversPrefix(titleId)}/${requireUuid(coverId)}.webp`);
}

export function healthProbesPrefix(): StorageKey {
  return parseStorageKey('health/probes');
}

export function healthProbeKey(probeId: string): StorageKey {
  return parseStorageKey(`${healthProbesPrefix()}/${requireUuid(probeId)}`);
}
