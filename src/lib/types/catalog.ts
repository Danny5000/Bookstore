export type TitleKind = 'novel' | 'comic';
export type ReadingDirection = 'ltr' | 'rtl';
export type PanelMode = 'auto' | 'manual' | 'off';

export interface Chapter {
  title: string;
  paras: string[];
}

export interface TitleBase {
  id: string;
  title: string;
  author: string;
  price: number;
  released: string;
  cover: number;
  coverUrl?: string | null;
  summary: string;
}

export interface NovelTitle extends TitleBase {
  kind: 'novel';
  chapters?: Chapter[];
  fixed?: boolean;
  pages?: number;
  sourceFile?: string | null;
  samplePages?: number;
  pageNames?: never;
  direction?: never;
  panelMode?: never;
}

export interface ComicTitle extends TitleBase {
  kind: 'comic';
  pages: number;
  pageNames?: string[];
  direction?: ReadingDirection;
  panelMode?: PanelMode;
  chapters?: never;
  fixed?: never;
  sourceFile?: never;
  samplePages?: never;
}

export type Title = NovelTitle | ComicTitle;
