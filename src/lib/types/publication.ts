export type PublicationFormat = 'prose' | 'comic';
export type ReadingDirection = 'ltr' | 'rtl';
export type ReaderAccess = 'preview' | 'admin';
export type InlineMark = 'strong' | 'emphasis' | 'code' | 'subscript' | 'superscript';

export interface InlineFragment {
  text: string;
  marks: readonly InlineMark[];
  href?: string;
}

export type ProseBlockData =
  | {
      kind: 'heading';
      level: 1 | 2 | 3 | 4 | 5 | 6;
      fragments: readonly InlineFragment[];
    }
  | { kind: 'paragraph'; fragments: readonly InlineFragment[] }
  | { kind: 'quote'; fragments: readonly InlineFragment[] }
  | { kind: 'list'; ordered: boolean; items: readonly (readonly InlineFragment[])[] }
  | { kind: 'image'; imageId: string; alt: string }
  | { kind: 'break' };

export interface PanelRegionDto {
  id: string;
  ordinal: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PublicationMediaDto {
  url: string;
  checksumSha256: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
}

export interface CatalogTitleSummary {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  creatorName: string;
  format: PublicationFormat;
  priceMinor: number;
  currency: string;
  cover: PublicationMediaDto | null;
}

export interface CatalogTitleDetail extends CatalogTitleSummary {
  description: string;
  previewUrl: string;
}

export interface ProseBlockDto {
  id: string;
  ordinal: number;
  content: ProseBlockData;
}

export interface ProseSectionDto {
  id: string;
  ordinal: number;
  label: string | null;
  blocks: readonly ProseBlockDto[];
}

export interface ProseImageDto extends PublicationMediaDto {
  id: string;
}

export interface ComicPageDto extends PublicationMediaDto {
  id: string;
  ordinal: number;
  panels: readonly PanelRegionDto[];
}

interface ReaderDocumentBase {
  titleId: string;
  revisionId: string;
  presentationId: string;
  title: string;
  access: ReaderAccess;
  readingDirection: ReadingDirection;
}

export interface ProseReaderDocument extends ReaderDocumentBase {
  format: 'prose';
  sections: readonly ProseSectionDto[];
  images: readonly ProseImageDto[];
}

export interface ComicReaderDocument extends ReaderDocumentBase {
  format: 'comic';
  guidedViewEnabled: boolean;
  pages: readonly ComicPageDto[];
}

export type ReaderDocument = ProseReaderDocument | ComicReaderDocument;

export type PresentationInput =
  | {
      format: 'prose';
      readingDirection: ReadingDirection;
      guidedViewEnabled: false;
      previewSectionId: string;
      previewBlockId: string;
      previewPageId: null;
    }
  | {
      format: 'comic';
      readingDirection: ReadingDirection;
      guidedViewEnabled: boolean;
      previewSectionId: null;
      previewBlockId: null;
      previewPageId: string;
    };
