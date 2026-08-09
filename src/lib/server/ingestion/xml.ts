import type { Readable } from 'node:stream';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { IngestionError } from './errors';

export type OrderedXmlNode = Record<string, unknown>;
export type OrderedXmlDocument = readonly OrderedXmlNode[];

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  trimValues: false
});

function xmlError(
  code: 'xml_limit' | 'xml_syntax' | 'xml_unsafe_declaration',
  safeMessage: string,
  cause?: unknown
): IngestionError {
  return new IngestionError(code, safeMessage, false, cause === undefined ? undefined : { cause });
}

function localName(value: string): string {
  return value.slice(value.lastIndexOf(':') + 1);
}

function isOrderedXmlNode(value: unknown): value is OrderedXmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOrderedXml(bytes: Buffer, maxBytes: number): OrderedXmlDocument {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength > maxBytes) {
    throw xmlError('xml_limit', 'XML input exceeds the size limit');
  }
  const text = bytes.toString('utf8');
  if (/<\s*!\s*(?:doctype|entity)\b/iu.test(text)) {
    throw xmlError('xml_unsafe_declaration', 'XML declarations with entities are unsupported');
  }
  const validation = XMLValidator.validate(text);
  if (validation !== true) {
    throw xmlError('xml_syntax', 'XML syntax is invalid');
  }

  try {
    const result: unknown = parser.parse(text);
    if (!Array.isArray(result) || !result.every(isOrderedXmlNode)) {
      throw new Error('Ordered XML parser returned an unexpected document shape');
    }
    return result;
  } catch (cause: unknown) {
    if (cause instanceof IngestionError) throw cause;
    throw xmlError('xml_syntax', 'XML syntax is invalid', cause);
  }
}

export async function readOrderedXml(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal
): Promise<OrderedXmlDocument> {
  if (signal.aborted) {
    stream.destroy();
    throw new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
  }
  const abortError = new IngestionError('ingestion_aborted', 'Ingestion was aborted', false);
  const abort = () => stream.destroy(abortError);
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let byteSize = 0;

  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > maxBytes) {
        const cause = xmlError('xml_limit', 'XML input exceeds the size limit');
        stream.destroy(cause);
        throw cause;
      }
      chunks.push(bytes);
    }
  } catch (cause: unknown) {
    if (signal.aborted) throw abortError;
    throw cause;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return parseOrderedXml(Buffer.concat(chunks), maxBytes);
}

export function xmlElementName(node: OrderedXmlNode): string | null {
  const name = Object.keys(node).find(
    (key) => key !== ':@' && key !== '#text' && key !== '#cdata' && key !== '#comment'
  );
  return name ? localName(name) : null;
}

export function xmlChildNodes(
  container: OrderedXmlNode | OrderedXmlDocument
): readonly OrderedXmlNode[] {
  if (Array.isArray(container)) return container as OrderedXmlDocument;
  const node = container as OrderedXmlNode;
  const elementKey = Object.keys(node).find(
    (key) => key !== ':@' && key !== '#text' && key !== '#cdata' && key !== '#comment'
  );
  if (!elementKey) return [];
  const children = node[elementKey];
  return Array.isArray(children) && children.every(isOrderedXmlNode) ? children : [];
}

export function xmlChildElements(
  container: OrderedXmlNode | OrderedXmlDocument,
  expectedLocalName?: string
): readonly OrderedXmlNode[] {
  return xmlChildNodes(container).filter((node) => {
    const name = xmlElementName(node);
    return name !== null && (expectedLocalName === undefined || name === expectedLocalName);
  });
}

export function xmlAttribute(node: OrderedXmlNode, expectedLocalName: string): string | undefined {
  const attributes = node[':@'];
  if (!isOrderedXmlNode(attributes)) return undefined;
  for (const [name, value] of Object.entries(attributes)) {
    if (localName(name.replace(/^@_/u, '')) === expectedLocalName && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

export function xmlTextContent(node: OrderedXmlNode): string {
  const directText = node['#text'];
  if (typeof directText === 'string') return directText;
  const cdata = node['#cdata'];
  if (typeof cdata === 'string') return cdata;
  return xmlChildNodes(node).map(xmlTextContent).join('');
}
