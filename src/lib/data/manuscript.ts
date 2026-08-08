import type { Chapter } from '$lib/types/catalog';

export function parseManuscript(text: string): Chapter[] {
  const parsed: Chapter[] = [];
  text.split(/\n(?=##\s)/).forEach((block) => {
    const lines = block.split('\n').filter((line) => line.trim());
    if (lines.length === 0) return;

    const first = lines[0];
    let title = 'Chapter ' + (parsed.length + 1);
    let body = lines;
    if (first !== undefined && /^##\s/.test(first)) {
      title = first.replace(/^##\s*/, '');
      body = lines.slice(1);
    }
    parsed.push({ title, paras: body });
  });
  return parsed;
}
