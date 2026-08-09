import { IngestionError } from './errors';

const comicCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base'
});

function comparePaths(left: string, right: string): number {
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === undefined) return -1;
    if (rightSegment === undefined) return 1;
    const compared = comicCollator.compare(leftSegment, rightSegment);
    if (compared !== 0) return compared;
  }
  throw new IngestionError(
    'comic_ambiguous_page_order',
    'Comic page filenames produce an ambiguous reading order',
    false
  );
}

export function naturalComicOrder(paths: readonly string[]): readonly string[] {
  const normalized = paths.map((path) => path.replaceAll('\\', '/').normalize('NFC'));
  return normalized.toSorted(comparePaths);
}
