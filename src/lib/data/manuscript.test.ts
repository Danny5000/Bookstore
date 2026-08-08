import { describe, expect, it } from 'vitest';
import { parseManuscript } from './manuscript';

describe('parseManuscript', () => {
  it('uses markdown chapter headings as titles', () => {
    expect(parseManuscript('## One\nFirst paragraph\n## Two\nSecond paragraph')).toEqual([
      { title: 'One', paras: ['First paragraph'] },
      { title: 'Two', paras: ['Second paragraph'] }
    ]);
  });

  it('supplies a chapter name when no heading is present', () => {
    expect(parseManuscript('Opening paragraph')).toEqual([
      { title: 'Chapter 1', paras: ['Opening paragraph'] }
    ]);
  });
});
