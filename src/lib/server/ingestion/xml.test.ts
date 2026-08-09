import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  parseOrderedXml,
  readOrderedXml,
  xmlAttribute,
  xmlChildElements,
  xmlChildNodes,
  xmlElementName,
  xmlTextContent
} from './xml';

describe('bounded ordered XML parsing', () => {
  it('parses namespaced XML through local-name helpers', () => {
    const document = parseOrderedXml(
      Buffer.from(
        '<opf:package xmlns:opf="urn:opf" unique-identifier="book"><opf:metadata><dc:title xmlns:dc="urn:dc">Safe</dc:title></opf:metadata></opf:package>'
      ),
      2_048
    );
    const root = xmlChildElements(document, 'package')[0]!;
    const metadata = xmlChildElements(root, 'metadata')[0]!;
    const title = xmlChildElements(metadata, 'title')[0]!;

    expect(xmlElementName(root)).toBe('package');
    expect(xmlAttribute(root, 'unique-identifier')).toBe('book');
    expect(xmlTextContent(title)).toBe('Safe');
  });

  it('preserves the order of mixed element and text nodes', () => {
    const document = parseOrderedXml(Buffer.from('<root><b>safe</b> text<i>after</i></root>'), 1024);
    const root = xmlChildElements(document, 'root')[0]!;

    expect(
      xmlChildNodes(root).map((node) => xmlElementName(node) ?? '#text')
    ).toEqual(['b', '#text', 'i']);
    expect(xmlTextContent(root)).toBe('safe textafter');
  });

  it('rejects malformed syntax and unsafe declarations', () => {
    expect(() => parseOrderedXml(Buffer.from('<root><open></root>'), 1024)).toThrowError(
      expect.objectContaining({ code: 'xml_syntax' })
    );
    expect(() => parseOrderedXml(Buffer.from('<!DOCTYPE root><root/>'), 1024)).toThrowError(
      expect.objectContaining({ code: 'xml_unsafe_declaration' })
    );
    expect(() =>
      parseOrderedXml(Buffer.from('<!EnTiTy unsafe "value"><root/>'), 1024)
    ).toThrowError(expect.objectContaining({ code: 'xml_unsafe_declaration' }));
  });

  it('rejects buffers and streams above the XML limit', async () => {
    expect(() => parseOrderedXml(Buffer.from('<root>too large</root>'), 10)).toThrowError(
      expect.objectContaining({ code: 'xml_limit' })
    );
    await expect(
      readOrderedXml(Readable.from(['<root>', 'too large', '</root>']), 10, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'xml_limit' });
  });

  it('rejects an aborted stream read', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      readOrderedXml(Readable.from(['<root/>']), 1024, controller.signal)
    ).rejects.toMatchObject({ code: 'ingestion_aborted' });
  });
});
