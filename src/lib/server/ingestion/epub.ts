import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { ProseBlockData } from '$lib/types/publication';
import {
  revisionCoverSuggestionKey,
  revisionProseImageKey,
  type StorageKey
} from '../storage/keys';
import type { ObjectStorage } from '../storage/types';
import { openArchive, type ArchiveEntry, type ArchiveSession } from './archive';
import { IngestionError, type IngestionWarning } from './errors';
import { normalizeImage, type NormalizedImage } from './image';
import type { IngestionLimits } from './limits';
import {
  SEMANTIC_FINGERPRINT_VERSION,
  fingerprintProseBlock
} from '../reader-state/fingerprint';
import { convertXhtmlToBlocks, stableIngestionId } from './prose';
import {
  readOrderedXml,
  xmlAttribute,
  xmlChildElements,
  xmlChildNodes,
  xmlElementName,
  xmlTextContent,
  type OrderedXmlDocument,
  type OrderedXmlNode
} from './xml';

export interface IngestEpubInput {
  storage: ObjectStorage;
  sourceKey: StorageKey;
  titleId: string;
  revisionId: string;
  limits: IngestionLimits;
  signal: AbortSignal;
}

export interface EpubMetadata {
  identifier: string;
  title: string;
  creator: string;
  modifiedAt: string;
}

export interface EpubImageRow extends NormalizedImage {
  id: string;
  sourcePath: string;
  altText: string;
}

export interface EpubBlockRow {
  id: string;
  ordinal: number;
  kind: ProseBlockData['kind'];
  content: ProseBlockData;
  imageId: string | null;
  semanticFingerprintSha256: string;
  semanticFingerprintVersion: typeof SEMANTIC_FINGERPRINT_VERSION;
}

export interface EpubSectionRow {
  id: string;
  ordinal: number;
  label: string | null;
  sourceReference: string;
  blocks: readonly EpubBlockRow[];
}

export interface EpubCoverSuggestion extends NormalizedImage {
  id: string;
  sourceDescription: string;
}

export interface EpubIngestionResult {
  metadata: EpubMetadata;
  sections: readonly EpubSectionRow[];
  images: readonly EpubImageRow[];
  coverSuggestion: EpubCoverSuggestion | null;
  warnings: readonly IngestionWarning[];
}

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: ReadonlySet<string>;
}

function epubError(
  code:
    | 'epub_mimetype'
    | 'epub_container'
    | 'epub_package'
    | 'epub_spine'
    | 'epub_navigation'
    | 'epub_content'
    | 'unsupported_media'
    | 'unsupported_fixed_layout'
    | 'unsupported_drm'
    | 'unsupported_svg',
  safeMessage: string
): IngestionError {
  return new IngestionError(code, safeMessage, false);
}

async function collectBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    byteSize += bytes.byteLength;
    if (byteSize > maxBytes) throw epubError('epub_content', 'EPUB resource is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function descendants(
  container: OrderedXmlNode | OrderedXmlDocument,
  expectedName: string
): OrderedXmlNode[] {
  const found: OrderedXmlNode[] = [];
  for (const child of xmlChildNodes(container)) {
    if (xmlElementName(child) === expectedName) found.push(child);
    found.push(...descendants(child, expectedName));
  }
  return found;
}

function firstDescendant(
  container: OrderedXmlNode | OrderedXmlDocument,
  expectedName: string
): OrderedXmlNode {
  const found = descendants(container, expectedName)[0];
  if (!found) throw epubError('epub_package', `EPUB ${expectedName} element is missing`);
  return found;
}

function nonemptyText(node: OrderedXmlNode | undefined, code: 'epub_package' | 'epub_navigation'): string {
  const value = node ? xmlTextContent(node).replace(/\s+/gu, ' ').trim() : '';
  if (!value) throw epubError(code, 'Required EPUB text is missing');
  return value;
}

function decodeLocalPath(
  basePath: string,
  reference: string,
  errorCode: 'epub_container' | 'epub_package' | 'epub_navigation' | 'epub_content',
  allowFragment: boolean
): string {
  if (
    !reference ||
    reference.includes('\\') ||
    /^\/\//u.test(reference) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(reference)
  ) {
    throw epubError(errorCode, 'EPUB resource path must be local');
  }
  const pathPart = allowFragment ? reference.split('#', 1)[0] ?? '' : reference;
  if (!pathPart || pathPart.includes('?') || (!allowFragment && pathPart.includes('#'))) {
    throw epubError(errorCode, 'EPUB resource path is invalid');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    throw epubError(errorCode, 'EPUB resource path is invalid');
  }
  const resolved = posix.normalize(
    basePath ? posix.join(posix.dirname(basePath), decoded) : decoded
  );
  if (posix.isAbsolute(resolved) || resolved.startsWith('../') || resolved === '..') {
    throw epubError(errorCode, 'EPUB resource path escapes the archive');
  }
  return resolved;
}

function entryMap(archive: ArchiveSession): ReadonlyMap<string, ArchiveEntry> {
  return new Map(archive.entries.filter((entry) => !entry.isDirectory).map((entry) => [entry.path, entry]));
}

async function readXmlEntry(
  archive: ArchiveSession,
  entry: ArchiveEntry,
  limits: IngestionLimits,
  signal: AbortSignal
): Promise<OrderedXmlDocument> {
  return readOrderedXml(await archive.read(entry), limits.maxXmlBytes, signal);
}

function requireEntry(
  entries: ReadonlyMap<string, ArchiveEntry>,
  path: string,
  code: 'epub_container' | 'epub_package' | 'epub_spine' | 'epub_navigation' | 'epub_content'
): ArchiveEntry {
  const entry = entries.get(path);
  if (!entry) throw epubError(code, 'Required EPUB resource is missing');
  return entry;
}

async function validateMimetype(archive: ArchiveSession): Promise<void> {
  const mimetype = archive.entries.find((entry) => entry.path === 'mimetype');
  if (
    !mimetype ||
    mimetype.isDirectory ||
    mimetype.localHeaderOffset !== 0 ||
    mimetype.compressionMethod !== 0 ||
    (mimetype.generalPurposeBitFlag & 0x08) !== 0
  ) {
    throw epubError('epub_mimetype', 'EPUB mimetype entry is invalid');
  }
  const bytes = await collectBounded(await archive.read(mimetype), 64);
  if (!bytes.equals(Buffer.from('application/epub+zip'))) {
    throw epubError('epub_mimetype', 'EPUB mimetype entry is invalid');
  }
}

async function resolvePackagePath(
  archive: ArchiveSession,
  entries: ReadonlyMap<string, ArchiveEntry>,
  limits: IngestionLimits,
  signal: AbortSignal
): Promise<string> {
  const containerEntry = requireEntry(
    entries,
    'META-INF/container.xml',
    'epub_container'
  );
  const container = await readXmlEntry(archive, containerEntry, limits, signal);
  const rootfiles = descendants(container, 'rootfile');
  if (rootfiles.length !== 1) {
    throw epubError('epub_container', 'EPUB container must contain one package document');
  }
  const fullPath = xmlAttribute(rootfiles[0]!, 'full-path');
  if (!fullPath) throw epubError('epub_container', 'EPUB package path is missing');
  const packagePath = decodeLocalPath('', fullPath, 'epub_container', false);
  requireEntry(entries, packagePath, 'epub_container');
  return packagePath;
}

function parseMetadata(packageDocument: OrderedXmlDocument): EpubMetadata {
  const metadata = firstDescendant(packageDocument, 'metadata');
  const metaElements = descendants(metadata, 'meta');
  if (
    metaElements.some(
      (node) =>
        xmlAttribute(node, 'property') === 'rendition:layout' &&
        xmlTextContent(node).trim().toLowerCase() === 'pre-paginated'
    )
  ) {
    throw epubError('unsupported_fixed_layout', 'Fixed-layout EPUB is unsupported');
  }
  const identifier = nonemptyText(descendants(metadata, 'identifier')[0], 'epub_package');
  const title = nonemptyText(descendants(metadata, 'title')[0], 'epub_package');
  const creator = nonemptyText(descendants(metadata, 'creator')[0], 'epub_package');
  const modifiedNode = metaElements.find(
    (node) => xmlAttribute(node, 'property') === 'dcterms:modified'
  );
  const modifiedAt = nonemptyText(modifiedNode, 'epub_package');
  return { identifier, title, creator, modifiedAt };
}

function parseManifest(
  packageDocument: OrderedXmlDocument,
  packagePath: string,
  entries: ReadonlyMap<string, ArchiveEntry>
): { byId: ReadonlyMap<string, ManifestItem>; byPath: ReadonlyMap<string, ManifestItem> } {
  const manifest = firstDescendant(packageDocument, 'manifest');
  const byId = new Map<string, ManifestItem>();
  const byPath = new Map<string, ManifestItem>();
  const allowedMedia = new Set([
    'application/xhtml+xml',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'text/css'
  ]);

  for (const itemNode of xmlChildElements(manifest, 'item')) {
    const id = xmlAttribute(itemNode, 'id')?.trim();
    const href = xmlAttribute(itemNode, 'href')?.trim();
    const mediaType = xmlAttribute(itemNode, 'media-type')?.trim().toLowerCase();
    if (!id || !href || !mediaType || byId.has(id)) {
      throw epubError('epub_package', 'EPUB manifest item is invalid or duplicated');
    }
    if (mediaType === 'image/svg+xml') {
      throw epubError('unsupported_svg', 'SVG EPUB resources are unsupported');
    }
    if (!allowedMedia.has(mediaType)) {
      throw epubError('unsupported_media', 'EPUB media type is unsupported');
    }
    let path: string;
    try {
      path = decodeLocalPath(packagePath, href, 'epub_package', false);
    } catch (cause: unknown) {
      if (cause instanceof IngestionError && /^https?:/iu.test(href)) {
        throw epubError('unsupported_media', 'Remote EPUB resources are unsupported');
      }
      throw cause;
    }
    if (byPath.has(path)) throw epubError('epub_package', 'EPUB manifest paths are duplicated');
    requireEntry(entries, path, 'epub_package');
    const properties = new Set(
      (xmlAttribute(itemNode, 'properties') ?? '').split(/\s+/u).filter(Boolean)
    );
    const item = { id, path, mediaType, properties } satisfies ManifestItem;
    byId.set(id, item);
    byPath.set(path, item);
  }
  return { byId, byPath };
}

function parseSpine(
  packageDocument: OrderedXmlDocument,
  manifestById: ReadonlyMap<string, ManifestItem>
): readonly ManifestItem[] {
  const spine = firstDescendant(packageDocument, 'spine');
  const result: ManifestItem[] = [];
  const seen = new Set<string>();
  for (const itemref of xmlChildElements(spine, 'itemref')) {
    const idref = xmlAttribute(itemref, 'idref')?.trim();
    if (!idref || seen.has(idref)) throw epubError('epub_spine', 'EPUB spine is invalid');
    seen.add(idref);
    const item = manifestById.get(idref);
    if (!item) throw epubError('epub_spine', 'EPUB spine reference is missing');
    if (item.mediaType === 'image/svg+xml') {
      throw epubError('unsupported_svg', 'SVG spine documents are unsupported');
    }
    if (item.mediaType !== 'application/xhtml+xml') {
      throw epubError('epub_spine', 'EPUB spine item must be XHTML');
    }
    if ((xmlAttribute(itemref, 'properties') ?? '').includes('rendition:layout-pre-paginated')) {
      throw epubError('unsupported_fixed_layout', 'Fixed-layout EPUB is unsupported');
    }
    result.push(item);
  }
  if (result.length === 0) throw epubError('epub_spine', 'EPUB spine is empty');
  return result;
}

async function navigationLabels(
  archive: ArchiveSession,
  entries: ReadonlyMap<string, ArchiveEntry>,
  manifest: ReadonlyMap<string, ManifestItem>,
  limits: IngestionLimits,
  signal: AbortSignal
): Promise<ReadonlyMap<string, string>> {
  const navItems = [...manifest.values()].filter((item) => item.properties.has('nav'));
  if (navItems.length !== 1 || navItems[0]!.mediaType !== 'application/xhtml+xml') {
    throw epubError('epub_navigation', 'EPUB navigation document is missing or ambiguous');
  }
  const navItem = navItems[0]!;
  const nav = await readXmlEntry(
    archive,
    requireEntry(entries, navItem.path, 'epub_navigation'),
    limits,
    signal
  );
  const toc = descendants(nav, 'nav').find((node) => xmlAttribute(node, 'type') === 'toc');
  if (!toc) throw epubError('epub_navigation', 'EPUB table of contents is missing');
  const labels = new Map<string, string>();
  for (const anchor of descendants(toc, 'a')) {
    const href = xmlAttribute(anchor, 'href');
    if (!href) continue;
    const path = decodeLocalPath(navItem.path, href, 'epub_navigation', true);
    const label = xmlTextContent(anchor).replace(/\s+/gu, ' ').trim();
    if (label && !labels.has(path)) labels.set(path, label);
  }
  if (labels.size === 0) throw epubError('epub_navigation', 'EPUB table of contents is empty');
  return labels;
}

function imageReferences(
  document: OrderedXmlDocument,
  resourcePath: string
): readonly { path: string; alt: string }[] {
  return descendants(document, 'img').map((node) => ({
    path: decodeLocalPath(
      resourcePath,
      xmlAttribute(node, 'src') ?? '',
      'epub_content',
      false
    ),
    alt: (xmlAttribute(node, 'alt') ?? '').trim().slice(0, 2_000)
  }));
}

export async function ingestEpub(input: IngestEpubInput): Promise<EpubIngestionResult> {
  const archive = await openArchive(input.storage, input.sourceKey, input.limits, input.signal);
  try {
    await validateMimetype(archive);
    const entries = entryMap(archive);
    if (entries.has('META-INF/encryption.xml')) {
      throw epubError('unsupported_drm', 'Encrypted EPUB resources are unsupported');
    }
    const packagePath = await resolvePackagePath(
      archive,
      entries,
      input.limits,
      input.signal
    );
    const packageDocument = await readXmlEntry(
      archive,
      requireEntry(entries, packagePath, 'epub_package'),
      input.limits,
      input.signal
    );
    const metadata = parseMetadata(packageDocument);
    const manifest = parseManifest(packageDocument, packagePath, entries);
    const spine = parseSpine(packageDocument, manifest.byId);
    const labels = await navigationLabels(
      archive,
      entries,
      manifest.byId,
      input.limits,
      input.signal
    );

    const sectionDocuments: { item: ManifestItem; document: OrderedXmlDocument }[] = [];
    const referencedImages = new Map<string, string>();
    for (const item of spine) {
      const document = await readXmlEntry(
        archive,
        requireEntry(entries, item.path, 'epub_content'),
        input.limits,
        input.signal
      );
      sectionDocuments.push({ item, document });
      for (const reference of imageReferences(document, item.path)) {
        const manifestImage = manifest.byPath.get(reference.path);
        if (!manifestImage || !manifestImage.mediaType.startsWith('image/')) {
          throw epubError('epub_content', 'Referenced EPUB image is missing');
        }
        if (!referencedImages.has(reference.path)) {
          referencedImages.set(reference.path, reference.alt);
        }
      }
    }

    const warnings: IngestionWarning[] = [];
    const images: EpubImageRow[] = [];
    const imageIdsByPath = new Map<string, string>();
    for (const [path, altText] of referencedImages) {
      const imageId = stableIngestionId(input.revisionId, path, 'image', 0);
      imageIdsByPath.set(path, imageId);
      const normalized = await normalizeImage({
        storage: input.storage,
        source: await archive.read(requireEntry(entries, path, 'epub_content')),
        destination: revisionProseImageKey(input.titleId, input.revisionId, imageId),
        profile: 'epub',
        limits: input.limits,
        signal: input.signal
      });
      warnings.push(...normalized.warnings);
      images.push({ id: imageId, sourcePath: path, altText, ...normalized });
    }

    const imageFingerprintsById = new Map(
      images.map((image) => [image.id, image.semanticFingerprintSha256] as const)
    );
    const sections: EpubSectionRow[] = sectionDocuments.map(({ item, document }, ordinal) => {
      const sectionId = stableIngestionId(input.revisionId, item.path, 'section', ordinal);
      const content = convertXhtmlToBlocks(document, {
        revisionId: input.revisionId,
        resourcePath: item.path,
        imageIdsByPath
      });
      const blocks = content.map((block, blockOrdinal): EpubBlockRow => {
        const imageFingerprint = block.kind === 'image'
          ? imageFingerprintsById.get(block.imageId)
          : undefined;
        if (block.kind === 'image' && !imageFingerprint) {
          throw epubError('epub_content', 'Referenced EPUB image fingerprint is missing');
        }
        return {
          id: stableIngestionId(input.revisionId, item.path, block.kind, blockOrdinal),
          ordinal: blockOrdinal,
          kind: block.kind,
          content: block,
          imageId: block.kind === 'image' ? block.imageId : null,
          semanticFingerprintSha256: fingerprintProseBlock({
            block,
            ...(imageFingerprint ? { imageFingerprintSha256: imageFingerprint } : {})
          }),
          semanticFingerprintVersion: SEMANTIC_FINGERPRINT_VERSION
        };
      });
      return {
        id: sectionId,
        ordinal,
        label: labels.get(item.path) ?? null,
        sourceReference: item.path,
        blocks
      };
    });

    const coverItems = [...manifest.byId.values()].filter((item) =>
      item.properties.has('cover-image')
    );
    if (coverItems.length > 1) throw epubError('epub_package', 'EPUB cover is ambiguous');
    let coverSuggestion: EpubCoverSuggestion | null = null;
    if (coverItems[0]) {
      const cover = coverItems[0];
      if (!cover.mediaType.startsWith('image/')) {
        throw epubError('unsupported_media', 'EPUB cover media type is unsupported');
      }
      const suggestionId = stableIngestionId(input.revisionId, cover.path, 'cover', 0);
      const normalized = await normalizeImage({
        storage: input.storage,
        source: await archive.read(requireEntry(entries, cover.path, 'epub_content')),
        destination: revisionCoverSuggestionKey(
          input.titleId,
          input.revisionId,
          suggestionId
        ),
        profile: 'epub',
        limits: input.limits,
        signal: input.signal
      });
      warnings.push(...normalized.warnings);
      coverSuggestion = {
        id: suggestionId,
        sourceDescription: 'EPUB package cover image',
        ...normalized
      };
    }

    return {
      metadata,
      sections: Object.freeze(sections),
      images: Object.freeze(images),
      coverSuggestion,
      warnings: Object.freeze(warnings)
    };
  } finally {
    await archive.close();
  }
}
