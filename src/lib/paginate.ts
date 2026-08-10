import type { PageBox, PageBoxInput, PaperId, TypefaceId } from '$lib/types/reader';

export function pageBox({
  vw,
  vh,
  narrow,
  fontSize,
  chrome = 244
}: PageBoxInput): PageBox {
  let ph = Math.max(200, Math.min(620, vh - chrome));
  let pw = Math.round(ph * 0.73);
  const maxWidth = narrow ? vw - 44 : (vw - 96) / 2;
  if (pw > maxWidth) {
    pw = Math.max(220, maxWidth);
    ph = Math.round(pw / 0.73);
  }
  return {
    pw,
    ph,
    pad: Math.max(16, Math.round(pw * 0.105)),
    fs: Math.max(12, Math.min(fontSize, Math.round(pw / 19)))
  };
}

interface PaperTheme {
  label: string;
  bg: string;
  ink: string;
}

interface Typeface {
  label: string;
  css: string;
}

export const PAPERS: Record<PaperId, PaperTheme> = {
  white: { label: 'White', bg: '#f7f5f1', ink: '#25211c' },
  sepia: { label: 'Sepia', bg: '#efe2c8', ink: '#3a2f21' },
  dim: { label: 'Dim', bg: '#2a2926', ink: '#cfc9be' }
};

export const TYPEFACES: Record<TypefaceId, Typeface> = {
  serif: { label: 'Newsreader', css: "'Newsreader', Georgia, serif" },
  sans: { label: 'Plex Sans', css: "'IBM Plex Sans', system-ui, sans-serif" },
  georgia: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" }
};
