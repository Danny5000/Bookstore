import { strToU8, zipSync, type AsyncZippable, type Zippable } from 'fflate';

export const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64'
);

export function zipEntriesFixture(entries: Zippable): Buffer {
  return Buffer.from(zipSync(entries, { level: 6 }));
}

export function validEpubFixture(overrides: Zippable = {}): Buffer {
  const containerXml = `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`;
  const packageXml = `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:identifier id="book-id">urn:uuid:test-book</dc:identifier>
        <dc:title>Fixture Book</dc:title><dc:creator>Pale Orbit</dc:creator>
        <meta property="dcterms:modified">2026-08-09T00:00:00Z</meta>
      </metadata>
      <manifest>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>
        <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
      </manifest>
      <spine><itemref idref="chapter-1"/></spine>
    </package>`;
  const navXhtml = `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"
      xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter-1.xhtml">Chapter One</a></li></ol>
    </nav></body></html>`;
  const chapterXhtml = `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>Safe text.</p></body></html>`;
  const entries = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(containerXml),
    'EPUB/package.opf': strToU8(packageXml),
    'EPUB/nav.xhtml': strToU8(navXhtml),
    'EPUB/chapter-1.xhtml': strToU8(chapterXhtml),
    'EPUB/images/cover.png': onePixelPng,
    ...overrides
  } satisfies Zippable;
  return zipEntriesFixture(entries);
}

export function validComicFixture(entries?: Zippable): Buffer {
  return zipEntriesFixture(
    entries ??
      ({
        'page-10.png': onePixelPng,
        'nested/page-2.png': onePixelPng,
        'page-1.png': onePixelPng,
        '__MACOSX/._page-1.png': strToU8('metadata'),
        '.DS_Store': strToU8('metadata'),
        'ComicInfo.xml': strToU8('<ComicInfo><Title>Fixture Comic</Title></ComicInfo>')
      } satisfies Zippable)
  );
}

// Compile-time guard: fixture inputs stay compatible with fflate's supported archive shape.
export type PublicationFixtureEntries = Zippable | AsyncZippable;
