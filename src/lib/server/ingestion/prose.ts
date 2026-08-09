import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { InlineFragment, InlineMark, ProseBlockData } from '$lib/types/publication';
import { IngestionError } from './errors';
import {
  xmlAttribute,
  xmlChildElements,
  xmlChildNodes,
  xmlElementName,
  type OrderedXmlDocument,
  type OrderedXmlNode
} from './xml';

export interface ProseResourceContext {
  revisionId: string;
  resourcePath: string;
  imageIdsByPath: ReadonlyMap<string, string>;
}

const markOrder: readonly InlineMark[] = [
  'strong',
  'emphasis',
  'code',
  'subscript',
  'superscript'
];
const executableElements = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'video',
  'audio',
  'canvas'
]);
const maximumInlineDepth = 32;
const maximumBlockText = 1_000_000;

function permanentError(
  code: 'unsupported_script' | 'unsupported_media' | 'epub_content',
  safeMessage: string
): IngestionError {
  return new IngestionError(code, safeMessage, false);
}

export function stableIngestionId(
  revisionId: string,
  resourcePath: string,
  elementKind: string,
  ordinal: number
): string {
  const bytes = createHash('sha256')
    .update(revisionId)
    .update('\0')
    .update(resourcePath)
    .update('\0')
    .update(elementKind)
    .update('\0')
    .update(String(ordinal))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rawText(node: OrderedXmlNode): string | null {
  const value = node['#text'];
  return typeof value === 'string' ? value : null;
}

function addMark(marks: readonly InlineMark[], mark: InlineMark): readonly InlineMark[] {
  return markOrder.filter((candidate) => candidate === mark || marks.includes(candidate));
}

function safeLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

function inlineFragments(
  node: OrderedXmlNode,
  marks: readonly InlineMark[] = [],
  href?: string,
  depth = 0
): InlineFragment[] {
  if (depth > maximumInlineDepth) {
    throw permanentError('epub_content', 'XHTML nesting is too deep');
  }
  const text = rawText(node);
  if (text !== null) return [{ text, marks, ...(href ? { href } : {}) }];
  const name = xmlElementName(node);
  if (!name) return [];
  if (executableElements.has(name)) {
    throw permanentError('unsupported_script', 'Executable or embedded XHTML is unsupported');
  }
  if (name === 'br') return [{ text: ' ', marks, ...(href ? { href } : {}) }];
  if (name === 'img') return [];

  let childMarks = marks;
  if (name === 'strong' || name === 'b') childMarks = addMark(marks, 'strong');
  else if (name === 'em' || name === 'i') childMarks = addMark(marks, 'emphasis');
  else if (name === 'code' || name === 'kbd' || name === 'samp') {
    childMarks = addMark(marks, 'code');
  } else if (name === 'sub') childMarks = addMark(marks, 'subscript');
  else if (name === 'sup') childMarks = addMark(marks, 'superscript');
  const childHref = name === 'a' ? safeLink(xmlAttribute(node, 'href')) : href;
  return xmlChildNodes(node).flatMap((child) =>
    inlineFragments(child, childMarks, childHref, depth + 1)
  );
}

function samePresentation(left: InlineFragment, right: InlineFragment): boolean {
  return (
    left.href === right.href &&
    left.marks.length === right.marks.length &&
    left.marks.every((mark, index) => mark === right.marks[index])
  );
}

function normalizeFragments(fragments: readonly InlineFragment[]): InlineFragment[] {
  const normalized: InlineFragment[] = [];
  let pendingWhitespace = '';
  for (const fragment of fragments) {
    const text = fragment.text.replace(/\s+/gu, ' ');
    if (!text) continue;
    if (text.trim().length === 0) {
      pendingWhitespace = ' ';
      continue;
    }
    const next: InlineFragment = {
      ...fragment,
      text: `${pendingWhitespace}${text}`
    };
    pendingWhitespace = '';
    const previous = normalized.at(-1);
    if (previous && samePresentation(previous, next)) previous.text += next.text;
    else normalized.push(next);
  }
  if (normalized[0]) normalized[0].text = normalized[0].text.trimStart();
  const last = normalized.at(-1);
  if (last) last.text = last.text.trimEnd();
  const present = normalized.filter((fragment) => fragment.text.length > 0);
  const textSize = present.reduce((total, fragment) => total + fragment.text.length, 0);
  if (textSize > maximumBlockText) {
    throw permanentError('epub_content', 'XHTML block text is too large');
  }
  return present;
}

function resolveLocalImage(src: string | undefined, context: ProseResourceContext): string {
  if (!src || /^\/\//u.test(src) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(src)) {
    throw permanentError('unsupported_media', 'Remote XHTML images are unsupported');
  }
  if (src.includes('\\')) {
    throw permanentError('epub_content', 'XHTML image path is invalid');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(src.split(/[?#]/u, 1)[0] ?? '');
  } catch {
    throw permanentError('epub_content', 'XHTML image path is invalid');
  }
  const resolved = posix.normalize(posix.join(posix.dirname(context.resourcePath), decoded));
  if (!decoded || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    throw permanentError('epub_content', 'XHTML image path is invalid');
  }
  const imageId = context.imageIdsByPath.get(resolved);
  if (!imageId) throw permanentError('epub_content', 'XHTML image resource is missing');
  return imageId;
}

function assertNoExecutableContent(nodes: readonly OrderedXmlNode[]): void {
  for (const node of nodes) {
    const name = xmlElementName(node);
    if (name && executableElements.has(name)) {
      throw permanentError('unsupported_script', 'Executable or embedded XHTML is unsupported');
    }
    assertNoExecutableContent(xmlChildNodes(node));
  }
}

function findFirstElement(
  nodes: readonly OrderedXmlNode[],
  expectedName: string
): OrderedXmlNode | undefined {
  for (const node of nodes) {
    if (xmlElementName(node) === expectedName) return node;
    const nested = findFirstElement(xmlChildNodes(node), expectedName);
    if (nested) return nested;
  }
  return undefined;
}

function blockFromImage(node: OrderedXmlNode, context: ProseResourceContext): ProseBlockData {
  return {
    kind: 'image',
    imageId: resolveLocalImage(xmlAttribute(node, 'src'), context),
    alt: (xmlAttribute(node, 'alt') ?? '').trim().slice(0, 2_000)
  };
}

function convertBlockChildren(
  container: OrderedXmlNode,
  context: ProseResourceContext,
  output: ProseBlockData[]
): void {
  for (const node of xmlChildNodes(container)) {
    const name = xmlElementName(node);
    if (!name) continue;
    if (/^h[1-6]$/u.test(name)) {
      const fragments = normalizeFragments(inlineFragments(node));
      if (fragments.length > 0) {
        output.push({
          kind: 'heading',
          level: Number(name[1]) as 1 | 2 | 3 | 4 | 5 | 6,
          fragments
        });
      }
    } else if (name === 'p') {
      const fragments = normalizeFragments(inlineFragments(node));
      if (fragments.length > 0) output.push({ kind: 'paragraph', fragments });
      for (const image of xmlChildElements(node, 'img')) output.push(blockFromImage(image, context));
    } else if (name === 'blockquote') {
      const fragments = normalizeFragments(inlineFragments(node));
      if (fragments.length > 0) output.push({ kind: 'quote', fragments });
    } else if (name === 'ol' || name === 'ul') {
      const items = xmlChildElements(node, 'li')
        .map((item) => normalizeFragments(inlineFragments(item)))
        .filter((fragments) => fragments.length > 0);
      if (items.length > 0) output.push({ kind: 'list', ordered: name === 'ol', items });
    } else if (name === 'hr') output.push({ kind: 'break' });
    else if (name === 'img') output.push(blockFromImage(node, context));
    else convertBlockChildren(node, context, output);
  }
}

export function convertXhtmlToBlocks(
  document: OrderedXmlDocument,
  context: ProseResourceContext
): readonly ProseBlockData[] {
  assertNoExecutableContent(document);
  const body = findFirstElement(document, 'body');
  if (!body) throw permanentError('epub_content', 'XHTML body is missing');
  const output: ProseBlockData[] = [];
  convertBlockChildren(body, context, output);
  return Object.freeze(output);
}
