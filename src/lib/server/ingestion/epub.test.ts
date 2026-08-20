import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { strToU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validEpubFixture,
  zipEntriesFixture
} from '../../../../tests/fixtures/publications';
import { stagingUploadKey } from '../storage/keys';
import { createLocalObjectStorage } from '../storage/local';
import type { ObjectStorage } from '../storage/types';
import { ingestEpub } from './epub';
import type { IngestionLimits } from './limits';

const titleId = '018f0000-0000-7000-8000-000000000010';
const revisionId = '018f0000-0000-7000-8000-000000000011';
const generation = 3;
const limits: IngestionLimits = Object.freeze({
  maxUploadBytes: 10_000_000,
  maxExpandedBytes: 20_000_000,
  maxEntries: 1_000,
  maxXmlBytes: 1_000_000,
  maxImagePixels: 100_000_000,
  maxCompressionRatio: 1_000,
  timeoutMs: 5_000
});

interface PackageOptions {
  metadataExtra?: string;
  manifestExtra?: string;
  spine?: string;
  includeNav?: boolean;
}

function packageDocument(options: PackageOptions = {}): string {
  return `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">urn:uuid:test-book</dc:identifier>
        <dc:title>Fixture Book</dc:title><dc:creator>Pale Orbit</dc:creator>
        <meta property="dcterms:modified">2026-08-09T00:00:00Z</meta>
        ${options.metadataExtra ?? ''}
      </metadata>
      <manifest>
        ${options.includeNav === false ? '' : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
        <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>
        <item id="station" href="images/station.png" media-type="image/png"/>
        <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
        ${options.manifestExtra ?? ''}
      </manifest>
      <spine>${options.spine ?? '<itemref idref="chapter-1"/><itemref idref="chapter-2"/>'}</spine>
    </package>`;
}

describe('EPUB ingestion', () => {
  let root: string;
  let storage: ObjectStorage;
  let uploadSequence: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-epub-test-'));
    storage = createLocalObjectStorage(root);
    uploadSequence = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function ingest(bytes: Buffer, signal: AbortSignal = AbortSignal.timeout(5_000)) {
    uploadSequence += 1;
    const sourceKey = stagingUploadKey(
      `018f0000-0000-7000-8000-${uploadSequence.toString().padStart(12, '0')}`
    );
    await storage.write(sourceKey, Readable.from([bytes]), { maxBytes: limits.maxUploadBytes });
    return ingestEpub({ storage, sourceKey, titleId, revisionId, generation, limits, signal });
  }

  it('returns a deterministic complete prose manifest in spine order', async () => {
    const result = await ingest(validEpubFixture());

    expect(result.metadata).toEqual({
      identifier: 'urn:uuid:test-book',
      title: 'Fixture Book',
      creator: 'Pale Orbit',
      modifiedAt: '2026-08-09T00:00:00Z'
    });
    expect(result.sections.map(({ ordinal, label, sourceReference }) => ({
      ordinal,
      label,
      sourceReference
    }))).toEqual([
      { ordinal: 0, label: 'Chapter One', sourceReference: 'EPUB/chapter-1.xhtml' },
      { ordinal: 1, label: 'Chapter Two', sourceReference: 'EPUB/chapter-2.xhtml' }
    ]);
    expect(result.sections[0]?.blocks.map(({ content }) => content)).toEqual([
      { kind: 'heading', level: 1, fragments: [{ text: 'Chapter One', marks: [] }] },
      {
        kind: 'paragraph',
        fragments: [
          { text: 'The ', marks: [] },
          { text: 'signal', marks: ['emphasis'] },
          { text: ' arrived.', marks: [] }
        ]
      },
      { kind: 'image', imageId: result.images[0]!.id, alt: 'A distant station' }
    ]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      sourcePath: 'EPUB/images/station.png',
      mediaType: 'image/webp',
      semanticFingerprintVersion: 1,
      width: 1,
      height: 1
    });
    expect(result.images[0]?.semanticFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.images[0]?.storageKey).toContain('/derived/v1/generations/3/prose-images/');
    expect(
      result.sections.flatMap((section) => section.blocks).every(
        (block) =>
          block.semanticFingerprintVersion === 1 &&
          /^[0-9a-f]{64}$/u.test(block.semanticFingerprintSha256)
      )
    ).toBe(true);
    expect(result.coverSuggestion).toMatchObject({
      sourceDescription: 'EPUB package cover image',
      mediaType: 'image/webp',
      semanticFingerprintVersion: 1,
      width: 1,
      height: 1
    });
    expect(result.coverSuggestion?.storageKey)
      .toContain('/derived/v1/generations/3/cover-suggestions/');
    expect(result.warnings).toEqual([]);
  });

  it('requires mimetype to be first, stored, descriptor-free, and exact', async () => {
    const unzipped = unzipSync(validEpubFixture());
    const rest = { ...unzipped };
    delete rest.mimetype;
    const notFirst = zipEntriesFixture({
      'before.txt': strToU8('before'),
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      ...rest
    });
    const compressed = validEpubFixture({
      mimetype: [strToU8('application/epub+zip'), { level: 6 }]
    });
    const wrong = validEpubFixture({ mimetype: [strToU8('application/zip'), { level: 0 }] });

    for (const fixture of [notFirst, compressed, wrong]) {
      await expect(ingest(fixture)).rejects.toMatchObject({ code: 'epub_mimetype', retryable: false });
    }
  });

  it('requires one local package document, unique manifest IDs, valid spine refs, and navigation', async () => {
    const remoteContainer = validEpubFixture({
      'META-INF/container.xml': strToU8(
        '<container><rootfiles><rootfile full-path="https://example.com/book.opf"/></rootfiles></container>'
      )
    });
    const duplicateManifest = validEpubFixture({
      'EPUB/package.opf': strToU8(
        packageDocument({
          manifestExtra: '<item id="chapter-1" href="duplicate.xhtml" media-type="application/xhtml+xml"/>'
        })
      )
    });
    const missingSpine = validEpubFixture({
      'EPUB/package.opf': strToU8(
        packageDocument({ spine: '<itemref idref="missing"/>' })
      )
    });
    const missingNavigation = validEpubFixture({
      'EPUB/package.opf': strToU8(packageDocument({ includeNav: false }))
    });

    for (const [fixture, code] of [
      [remoteContainer, 'epub_container'],
      [duplicateManifest, 'epub_package'],
      [missingSpine, 'epub_spine'],
      [missingNavigation, 'epub_navigation']
    ] as const) {
      await expect(ingest(fixture)).rejects.toMatchObject({ code });
    }
  });

  it('rejects fixed layout, DRM, scripts, remote resources, SVG, and unsupported media', async () => {
    const fixtures = [
      [
        validEpubFixture({
          'EPUB/package.opf': strToU8(
            packageDocument({ metadataExtra: '<meta property="rendition:layout">pre-paginated</meta>' })
          )
        }),
        'unsupported_fixed_layout'
      ],
      [validEpubFixture({ 'META-INF/encryption.xml': strToU8('<encryption/>') }), 'unsupported_drm'],
      [
        validEpubFixture({
          'EPUB/chapter-1.xhtml': strToU8(
            '<html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert(1)</script></body></html>'
          )
        }),
        'unsupported_script'
      ],
      [
        validEpubFixture({
          'EPUB/package.opf': strToU8(
            packageDocument({
              manifestExtra: '<item id="remote" href="https://example.com/image.png" media-type="image/png"/>'
            })
          )
        }),
        'unsupported_media'
      ],
      [
        validEpubFixture({
          'EPUB/package.opf': strToU8(
            packageDocument({
              manifestExtra: '<item id="vector" href="vector.svg" media-type="image/svg+xml"/>',
              spine: '<itemref idref="vector"/>'
            })
          ),
          'EPUB/vector.svg': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')
        }),
        'unsupported_svg'
      ],
      [
        validEpubFixture({
          'EPUB/package.opf': strToU8(
            packageDocument({
              manifestExtra: '<item id="pdf" href="file.pdf" media-type="application/pdf"/>'
            })
          ),
          'EPUB/file.pdf': strToU8('%PDF')
        }),
        'unsupported_media'
      ]
    ] as const;

    for (const [fixture, code] of fixtures) {
      await expect(ingest(fixture)).rejects.toMatchObject({ code, retryable: false });
    }
  });

  it('ignores publisher CSS rather than exposing it in semantic output', async () => {
    const result = await ingest(
      validEpubFixture({
        'EPUB/chapter-1.xhtml': strToU8(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><style>body{color:red}</style></head><body><p class="red" style="color:red">Visible</p></body></html>'
        )
      })
    );

    expect(JSON.stringify(result.sections)).not.toContain('color:red');
    expect(result.sections[0]?.blocks[0]?.content).toEqual({
      kind: 'paragraph',
      fragments: [{ text: 'Visible', marks: [] }]
    });
  });

  it('fails an already-aborted ingestion without publishing a result', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ingest(validEpubFixture(), controller.signal)).rejects.toMatchObject({
      code: 'ingestion_aborted'
    });
  });
});
